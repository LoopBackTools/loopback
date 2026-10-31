import type { Problem, Reply as ReplyBody } from "@loopbacktools/protocol";
import {
	Ask,
	AskPage,
	EventTicket,
	ServerEvent,
	Snapshot,
	Whoami,
} from "@loopbacktools/protocol/schema";
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Queue,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { applyEvent, type InboxEvent, type InboxState, initialInbox } from "./inbox.ts";

/** A request Loopback refused, or one that never reached it (`status` 0). */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
	status: Schema.Number,
	code: Schema.String,
	message: Schema.String,
}) {}

export interface LoopbackConfig {
	/** Where Loopback is served, such as `https://loopback.example.workers.dev`. */
	readonly baseUrl: string;
	/**
	 * The credential the deployment's gate accepts, or a function that fetches a fresh one. Leave it
	 * out where something in front of Loopback already signs requests in, as a Worker that vouches
	 * for its callers does: requests then carry no credential of their own.
	 */
	readonly token?: string | (() => string | Promise<string>);
	/** A `fetch` to use instead of the global one. */
	readonly fetch?: typeof globalThis.fetch;
	/** A `WebSocket` constructor to use instead of the global one. */
	readonly WebSocket?: typeof globalThis.WebSocket;
}

/** The subprotocol the event socket speaks. */
export const EVENTS_PROTOCOL = "loopback.v1";

/**
 * The prefix under which the socket offers its one-time ticket, since a browser cannot set headers
 * there. The token itself only ever travels in `Authorization`, which Cloudflare keeps out of logs.
 */
export const TICKET_PROTOCOL_PREFIX = "loopback.ticket.";

/** How often the socket sends a keep-alive ping. */
const PING_MS = 25_000;

/** Reconnects back off from half a second to ten, with jitter. */
const RECONNECT = Schedule.min([
	Schedule.exponential("500 millis"),
	Schedule.spaced("10 seconds"),
]).pipe(Schedule.jittered);

export interface LoopbackApi {
	readonly whoami: Effect.Effect<Whoami, ApiError>;
	/** Every open ask and the most recently closed. */
	readonly snapshot: Effect.Effect<Snapshot, ApiError>;
	readonly ask: (id: string) => Effect.Effect<Ask, ApiError>;
	/** Closed asks, newest first, before `before` when given. */
	readonly history: (page?: {
		readonly before?: string;
		readonly limit?: number;
	}) => Effect.Effect<AskPage, ApiError>;
	readonly reply: (id: string, reply: ReplyBody) => Effect.Effect<Ask, ApiError>;
	/** An uploaded image, for showing in a review. */
	readonly file: (uploadId: string) => Effect.Effect<Blob, ApiError>;
	/** The event socket's frames, reconnecting for as long as the stream runs. */
	readonly events: Stream.Stream<InboxEvent>;
	/** The inbox, kept current from `events`: one state per change. */
	readonly inbox: Stream.Stream<InboxState>;
}

class SocketClosed extends Schema.TaggedError<SocketClosed>()("SocketClosed", {}) {}

/** A frame as the contract says it is, or none for one that isn't a frame at all. */
const decodeFrame = Schema.decodeUnknownOption(ServerEvent);

export const make = (config: LoopbackConfig): LoopbackApi => {
	const base = config.baseUrl.replace(/\/+$/, "");
	// The globals are looked up per call, so a polyfill or stub installed after this runs is used.
	const fetcher: typeof globalThis.fetch =
		config.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const socketClass = () => config.WebSocket ?? globalThis.WebSocket;
	const { token: source } = config;
	const token = Effect.tryPromise({
		try: async () => (source === undefined || typeof source === "string" ? source : source()),
		catch: (error) =>
			new ApiError({
				status: 0,
				code: "token",
				message: error instanceof Error ? error.message : String(error),
			}),
	});

	/** A response body that is not what the contract says it is. */
	const unreadable = (response: Response) => () =>
		new ApiError({
			status: response.status,
			code: "invalid_body",
			message: `Loopback answered ${response.status} with a body that could not be read.`,
		});

	const request = (path: string, init: RequestInit = {}) =>
		Effect.gen(function* () {
			const headers = new Headers(init.headers);
			const credential = yield* token;
			if (credential !== undefined) headers.set("Authorization", `Bearer ${credential}`);
			const response = yield* Effect.tryPromise({
				try: (signal) => fetcher(`${base}/api/v1${path}`, { ...init, headers, signal }),
				catch: (error) =>
					new ApiError({
						status: 0,
						code: "network",
						message: error instanceof Error ? error.message : String(error),
					}),
			});
			if (response.ok) return response;
			const problem: Partial<Problem> = yield* Effect.promise(() =>
				response.json().catch(() => ({})),
			);
			return yield* new ApiError({
				status: response.status,
				code: problem.code ?? "unknown",
				message: problem.message ?? response.statusText,
			});
		});

	/**
	 * A response body, decoded as the contract says it is rather than cast to it. A message from a
	 * newer revision decodes to the `unknown` member of its union; a body that isn't the contract at
	 * all is refused as `invalid_body`.
	 */
	const read =
		<A, I>(schema: Schema.Codec<A, I>) =>
		(path: string, init?: RequestInit) =>
			Effect.flatMap(request(path, init), (response) =>
				Effect.tryPromise({
					try: (): Promise<unknown> => response.json(),
					catch: unreadable(response),
				}).pipe(
					Effect.flatMap((body) =>
						Effect.mapError(Schema.decodeUnknownEffect(schema)(body), unreadable(response)),
					),
				),
			);

	/**
	 * One connection: its frames, then a failure when it closes. Only a connection that was live
	 * reports the drop: the retry's backoff starts over whenever the stream emits, so one that never
	 * connected must emit nothing for the next attempt to wait longer.
	 */
	const connection = Stream.callback<InboxEvent, SocketClosed>((queue) =>
		Effect.gen(function* () {
			const Socket = socketClass();
			const { ticket } = yield* Effect.mapError(
				read(EventTicket)("/events/tickets", { method: "POST" }),
				() => new SocketClosed(),
			);
			const url = `${base.replace(/^http/, "ws")}/api/v1/events`;
			const closed = yield* Deferred.make<void>();
			const socket = yield* Effect.acquireRelease(
				Effect.try({
					try: () => new Socket(url, [EVENTS_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`]),
					catch: () => new SocketClosed(),
				}),
				(open) => Effect.sync(() => open.close()),
			);
			let live = false;
			socket.addEventListener("message", (message) => {
				if (typeof message.data !== "string" || message.data === "pong") return;
				let frame: unknown;
				try {
					frame = JSON.parse(message.data);
				} catch {
					return;
				}
				// A frame of a type this client doesn't know, from a newer revision, is skipped.
				const event = decodeFrame(frame);
				if (Option.isNone(event) || event.value.type === "unknown") return;
				live = true;
				Queue.offerUnsafe(queue, event.value);
			});
			const close = () => Deferred.doneUnsafe(closed, Exit.void);
			socket.addEventListener("close", close);
			socket.addEventListener("error", close);
			const ping = setInterval(() => {
				if (socket.readyState === Socket.OPEN) socket.send("ping");
			}, PING_MS);
			yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(ping)));
			yield* Deferred.await(closed);
			if (live) Queue.offerUnsafe(queue, { type: "disconnected" });
			return yield* new SocketClosed();
		}),
	);

	const events = connection.pipe(
		Stream.retry(RECONNECT),
		Stream.catch(() => Stream.empty),
	);

	return {
		whoami: read(Whoami)("/whoami"),
		snapshot: read(Snapshot)("/snapshot"),
		ask: (id) => read(Ask)(`/asks/${encodeURIComponent(id)}`),
		history: (page = {}) => {
			const query = new URLSearchParams();
			if (page.before !== undefined) query.set("before", page.before);
			if (page.limit !== undefined) query.set("limit", String(page.limit));
			const search = query.size === 0 ? "" : `?${query}`;
			return read(AskPage)(`/asks${search}`);
		},
		reply: (id, reply) =>
			read(Ask)(`/asks/${encodeURIComponent(id)}/reply`, {
				method: "POST",
				body: JSON.stringify(reply),
				headers: { "Content-Type": "application/json" },
			}),
		file: (uploadId) =>
			Effect.flatMap(request(`/files/${encodeURIComponent(uploadId)}`), (response) =>
				Effect.tryPromise({ try: () => response.blob(), catch: unreadable(response) }),
			),
		events,
		inbox: events.pipe(Stream.scan(() => initialInbox, applyEvent)),
	};
};

/** The Loopback client as an Effect service. */
export class LoopbackClient extends Context.Service<LoopbackClient, LoopbackApi>()(
	"@loopbacktools/sdk/LoopbackClient",
) {
	static readonly layer = (config: LoopbackConfig) => Layer.succeed(LoopbackClient, make(config));
}
