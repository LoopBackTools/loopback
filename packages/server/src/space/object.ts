import { SqliteClient } from "@effect/sql-sqlite-do";
import { BUILD_HEADER, REVISION_HEADER, type ServerEvent } from "@loopbacktools/protocol";
import { REVISION } from "@loopbacktools/protocol/schema";
import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Layer, Logger, ManagedRuntime } from "effect";
import { readArguments } from "./arguments.ts";
import { migrations } from "./migrations.ts";
import { operations, snapshot, startWaiting, stopWaiting } from "./operations.ts";
import {
	buildOf,
	type Caller,
	encodeExit,
	type ExitJson,
	isLater,
	type OperationName,
	Outdated,
	REPLY_FRAME,
	type SpaceFailure,
} from "./rpc.ts";
import { Host, Presence } from "./services.ts";
import { AskStore, TicketStore, UploadStore } from "./store.ts";

/** The subprotocol an inbox speaks on the event socket. */
export const EVENTS_PROTOCOL = "loopback.v1";

/** How long a space that has refused newer code waits before restarting: long enough to answer. */
const RESTART_DELAY_MS = 100;

/**
 * What a socket is, kept with it through hibernation: an inbox's event socket, or an agent's wait on
 * one ask, and the code that accepted it. A socket accepted before sockets were told apart has no
 * `kind`, and is an inbox's.
 */
type Accepted =
	| { readonly kind?: "inbox"; readonly revision: number; readonly build: string | null }
	| {
			readonly kind: "wait";
			readonly askId: string;
			readonly revision: number;
			readonly build: string | null;
	  };

/** The tag a wait socket is accepted under, so a reply wakes only the agents waiting on its ask. */
const waitTag = (askId: string) => `wait:${askId}`;

/** Where a Worker opens a wait on an ask. */
const WAIT_PATH = /^\/wait\/([^/]+)$/;

/** The close code an inbox reconnects after when the space is now on other code: Service Restart. */
const RECONNECT_ONTO_NEW_CODE = 1012;

type SpaceServices = AskStore | UploadStore | TicketStore | Host | Presence;

/**
 * One space: its asks, their threads, upload tickets, and the inboxes watching it. Everything it
 * does is a space operation, served through `call`; `fetch` only accepts an inbox's WebSocket.
 */
export class Space extends DurableObject {
	#runtime: ManagedRuntime.ManagedRuntime<SpaceServices, never>;
	/** The deploy this object's code is from. */
	readonly #ownBuild: string | undefined;
	/** Set once newer code has called: from then on everything is refused until the restart. */
	#restarting = false;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env as never);
		this.#ownBuild = buildOf(env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.#runtime = this.#build();
		// Build the runtime, migrations included, before the object takes any request.
		void ctx.blockConcurrencyWhile(() => this.#runtime.runPromise(Effect.void));
	}

	#build(): ManagedRuntime.ManagedRuntime<SpaceServices, never> {
		const sql = SqliteClient.layer({ storage: this.ctx.storage });
		const host = Layer.succeed(
			Host,
			Host.of({
				broadcast: (event) => this.#broadcast(event),
				wake: (askId) => this.#wake(askId),
				waiters: (askId) => this.#waiters(askId).length,
				spaceId: this.ctx.id.toString(),
			}),
		);
		return ManagedRuntime.make(
			Layer.mergeAll(AskStore.layer, UploadStore.layer, TicketStore.layer, migrations).pipe(
				Layer.provide(sql),
				Layer.merge(Layer.mergeAll(host, Presence.layer)),
				Layer.merge(Logger.layer([Logger.consoleJson])),
				Layer.orDie,
			),
		);
	}

	/**
	 * Deletes everything the space holds and closes the inboxes watching it. It carries on as an
	 * empty space: its schema is applied afresh before it takes another request. An agent waiting
	 * on an ask it held finds the ask gone at the end of its current lap.
	 */
	async erase(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.close(1000, "The space was erased.");
				} catch {
					// Already closing.
				}
			}
			const erased = this.#runtime;
			await this.ctx.storage.deleteAll();
			this.#runtime = this.#build();
			await this.#runtime.runPromise(Effect.void);
			await erased.dispose();
		});
	}

	/**
	 * For a while after a deploy, an active space can go on running the code it started with while a
	 * newer Worker calls it. Called by newer code, from a later build or writing a later revision of
	 * the contract, it refuses, running nothing, and restarts onto that code a moment later, once the
	 * refusal is on its way; whatever reaches it until then is refused the same way. A caller retries
	 * what was refused. Older code calling a newer space carries on, as does code from before callers
	 * named their version, which passes nothing.
	 */
	#outdatedFor(
		caller:
			| { readonly revision?: number | undefined; readonly build?: string | undefined }
			| undefined,
	): boolean {
		const newer =
			(caller?.revision ?? REVISION) > REVISION || isLater(caller?.build, this.#ownBuild);
		if (!this.#restarting && !newer) return false;
		if (!this.#restarting) {
			this.#restarting = true;
			setTimeout(
				() => this.ctx.abort("Newer code called this space: restarting onto it."),
				RESTART_DELAY_MS,
			);
		}
		return true;
	}

	/**
	 * Runs one space operation on the arguments it decodes them to, and answers with its Exit, encoded
	 * for the trip back.
	 */
	async call(method: OperationName, args: readonly unknown[], caller?: Caller): Promise<ExitJson> {
		if (this.#outdatedFor(caller)) return encodeExit(Exit.fail(new Outdated()));
		if (!Object.hasOwn(operations, method)) {
			return encodeExit(
				await Effect.runPromiseExit(Effect.die(new Error(`No operation ${method}`))),
			);
		}
		const operation = operations[method] as (
			...args: readonly unknown[]
		) => Effect.Effect<unknown, SpaceFailure, SpaceServices>;
		return encodeExit(
			await this.#runtime.runPromiseExit(
				Effect.flatMap(readArguments(method, args), (read) => operation(...read)),
			),
		);
	}

	/**
	 * Accepts a WebSocket: an inbox's event socket, sent the space as it stands, or an agent's wait on
	 * one ask (`/wait/<askId>`), which is only ever sent the reply frame.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}
		// The inbox or the Worker reconnects, by then to the space on the new code.
		const revision = request.headers.get(REVISION_HEADER);
		const handedBy = {
			revision: revision === null ? undefined : Number(revision),
			build: request.headers.get(BUILD_HEADER) ?? undefined,
		};
		if (this.#outdatedFor(handedBy)) {
			return new Response("This space is restarting onto newer code.", {
				status: 503,
				headers: { "Retry-After": "1" },
			});
		}
		const waitingOn = WAIT_PATH.exec(new URL(request.url).pathname)?.[1];
		return waitingOn === undefined
			? this.#acceptInbox(request)
			: this.#acceptWait(decodeURIComponent(waitingOn));
	}

	async #acceptInbox(request: Request): Promise<Response> {
		// Read the space first: a socket is only accepted once there is something to send it.
		const current = await this.#runtime.runPromise(snapshot);
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const accepted: Accepted = { kind: "inbox", revision: REVISION, build: this.#ownBuild ?? null };
		server.serializeAttachment(accepted);
		const first: ServerEvent = { type: "snapshot", snapshot: current };
		server.send(JSON.stringify(first));
		const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
			.split(",")
			.map((protocol) => protocol.trim());
		return new Response(null, {
			status: 101,
			webSocket: client,
			...(offered.includes(EVENTS_PROTOCOL)
				? { headers: { "Sec-WebSocket-Protocol": EVENTS_PROTOCOL } }
				: {}),
		});
	}

	/**
	 * Accepts an agent's wait on an ask, counted from then on as an agent waiting on it. A wait whose
	 * reply is already there is woken at once. While the space holds nothing but wait sockets it can
	 * hibernate: a reply wakes it, and it wakes the waiters.
	 */
	async #acceptWait(askId: string): Promise<Response> {
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [waitTag(askId)]);
		const accepted: Accepted = {
			kind: "wait",
			askId,
			revision: REVISION,
			build: this.#ownBuild ?? null,
		};
		server.serializeAttachment(accepted);
		const started = await this.#runtime.runPromise(
			startWaiting(askId).pipe(
				Effect.catchTag("AskNotFound", () => Effect.succeed("missing" as const)),
			),
		);
		if (started === "missing") {
			server.close(1000, "No such ask.");
			return new Response("No such ask.", { status: 404 });
		}
		if (started) server.send(REPLY_FRAME);
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Inboxes and waiting Workers only send keep-alive pings, which the auto-response answers without
	 * waking us.
	 */
	override async webSocketMessage(): Promise<void> {}

	/**
	 * A socket closed. The runtime completes the close handshake itself; a wait's closing is what
	 * tells inboxes its agent has stopped waiting.
	 */
	override async webSocketClose(socket: WebSocket): Promise<void> {
		const accepted = socket.deserializeAttachment() as Accepted | null;
		if (accepted?.kind !== "wait") return;
		await this.#runtime.runPromise(stopWaiting(accepted.askId));
	}

	/** The wait sockets open on an ask. One closing is no longer counted. */
	#waiters(askId: string): WebSocket[] {
		return this.ctx
			.getWebSockets(waitTag(askId))
			.filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
	}

	/** Sends every agent waiting on the ask the reply frame. */
	#wake(askId: string): Effect.Effect<void> {
		return Effect.sync(() => {
			for (const socket of this.#waiters(askId)) {
				try {
					socket.send(REPLY_FRAME);
				} catch {
					// A socket that is closing misses the frame; its agent's next wait finds the reply.
				}
			}
		});
	}

	/**
	 * Whether a socket was accepted by other code than this. A hibernated socket stays open while its
	 * space moves onto new code, so an inbox could go on hearing frames its page can't read, and never
	 * learn that Loopback was updated.
	 */
	#acceptedByOther(socket: WebSocket): boolean {
		const by = socket.deserializeAttachment() as Accepted | null;
		return by?.revision !== REVISION || by.build !== (this.#ownBuild ?? null);
	}

	/**
	 * Sends every inbox the event. One whose socket other code accepted is closed instead: it
	 * reconnects onto this code, and hears from the server that it is newer. Wait sockets hear only
	 * the reply frame.
	 */
	#broadcast(event: ServerEvent): Effect.Effect<void> {
		return Effect.sync(() => {
			const frame = JSON.stringify(event);
			for (const socket of this.ctx.getWebSockets()) {
				const accepted = socket.deserializeAttachment() as Accepted | null;
				if (accepted?.kind === "wait") continue;
				try {
					if (this.#acceptedByOther(socket)) {
						socket.close(RECONNECT_ONTO_NEW_CODE, "Loopback was updated.");
					} else {
						socket.send(frame);
					}
				} catch {
					// A socket that is closing misses the frame; it gets a fresh snapshot on reconnect.
				}
			}
		});
	}
}
