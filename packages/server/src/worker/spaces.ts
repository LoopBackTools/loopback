import { BUILD_HEADER, REVISION_HEADER } from "@loopbacktools/protocol";
import { REVISION } from "@loopbacktools/protocol/schema";
import { env as workerEnv, exports } from "cloudflare:workers";
import { Context, Data, Effect, Layer, Option, Queue, type Scope } from "effect";
import { AskNotFound } from "../domain/errors.ts";
import type { Space } from "../space/object.ts";
import {
	buildOf,
	type Caller,
	REPLY_FRAME,
	type SpaceClient,
	spaceClient,
	waitPath,
} from "../space/rpc.ts";
import type { WorkerBindings } from "./env.ts";
import { filesOf } from "./files.ts";
import type { Access } from "./gate.ts";

/**
 * The deployment's `Space` class, as the runtime binds every Durable Object class a Worker exports:
 * no binding in its configuration names the Worker, so a copy deployed under any name reaches its own.
 */
const namespace = (): DurableObjectNamespace<Space> =>
	(exports as unknown as { readonly Space: DurableObjectNamespace<Space> }).Space;

/** A space that could not take a wait just now: restarting onto new code, or unreachable. */
export class SpaceUnavailable extends Data.TaggedError("SpaceUnavailable")<{
	readonly cause: unknown;
}> {}

/** An agent's wait on one ask, open on its space. */
export interface Waiter {
	/** What the space says next: a reply landed, or the wait's socket closed under it. */
	readonly next: Effect.Effect<"reply" | "closed">;
	/** Keeps the connection alive. The space's auto-response answers it without waking the space. */
	readonly ping: Effect.Effect<void>;
}

/** Reaches the space a caller's access opens. */
export class Spaces extends Context.Service<
	Spaces,
	{
		readonly of: (access: Access) => SpaceClient;
		/** The object id of the space an access opens: how uploads and files name it. */
		readonly idOf: (access: Access) => string;
		/** A space by its object id, as an upload URL names it. None when the id is not one. */
		readonly byId: (spaceId: string) => Option.Option<SpaceClient>;
		/** Hands an inbox's WebSocket upgrade to the space, named by an access or by its object id. */
		readonly connect: (space: Access | string, request: Request) => Effect.Effect<Response>;
		/**
		 * Opens an agent's wait on an ask, closed when its scope closes. The space can hibernate
		 * while the wait is open, and wakes it when a reply lands.
		 */
		readonly wait: (
			access: Access,
			askId: string,
			afterSeq: number,
		) => Effect.Effect<Waiter, AskNotFound | SpaceUnavailable, Scope.Scope>;
	}
>()("loopback/Spaces") {
	static readonly layer = Layer.sync(Spaces, () => {
		const spaces = namespace();
		const stubOf = (access: Access) => spaces.getByName(access.space);
		// This code's version, which every call names, so a space still on older code knows to restart.
		const caller: Caller = { revision: REVISION, build: buildOf(workerEnv) };
		/** A request to a space, named by this code alone, whatever it brought with it. */
		const named = (request: Request) => {
			const copy = new Request(request);
			copy.headers.set(REVISION_HEADER, String(caller.revision));
			if (caller.build === undefined) copy.headers.delete(BUILD_HEADER);
			else copy.headers.set(BUILD_HEADER, caller.build);
			return copy;
		};
		return Spaces.of({
			of: (access) => spaceClient(() => stubOf(access), caller),
			idOf: (access) => spaces.idFromName(access.space).toString(),
			byId: (spaceId) => {
				if (!/^[0-9a-f]{64}$/.test(spaceId)) return Option.none();
				try {
					const id = spaces.idFromString(spaceId);
					return Option.some(spaceClient(() => spaces.get(id), caller));
				} catch {
					// A well-formed id this namespace did not mint.
					return Option.none();
				}
			},
			connect: (space, request) =>
				Effect.promise(() =>
					(typeof space === "string"
						? spaces.get(spaces.idFromString(space))
						: stubOf(space)
					).fetch(named(request)),
				),
			wait: (access, askId, afterSeq) =>
				Effect.acquireRelease(
					Effect.gen(function* () {
						const upgrade = new Request(`http://space${waitPath(askId, afterSeq)}`, {
							headers: { Upgrade: "websocket" },
						});
						const response = yield* Effect.tryPromise({
							try: () => stubOf(access).fetch(named(upgrade)),
							catch: (cause) => new SpaceUnavailable({ cause }),
						});
						if (response.status === 404) return yield* new AskNotFound({ askId });
						const socket = response.webSocket;
						if (response.status !== 101 || socket === null) {
							return yield* new SpaceUnavailable({ cause: `HTTP ${response.status}` });
						}
						// Listening before accepting, so a reply frame sent at once is not missed.
						const said = yield* Queue.unbounded<"reply" | "closed">();
						socket.addEventListener("message", (event) => {
							if (event.data === REPLY_FRAME) Queue.offerUnsafe(said, "reply");
						});
						socket.addEventListener("close", () => Queue.offerUnsafe(said, "closed"));
						socket.addEventListener("error", () => Queue.offerUnsafe(said, "closed"));
						socket.accept();
						return { socket, said };
					}),
					({ socket }) =>
						Effect.sync(() => {
							try {
								socket.close(1000, "The agent stopped waiting.");
							} catch {
								// Already closed.
							}
						}),
				).pipe(
					Effect.map(({ socket, said }): Waiter => ({
						next: Queue.take(said),
						ping: Effect.sync(() => {
							try {
								socket.send("ping");
							} catch {
								// Closing: `next` says so.
							}
						}),
					})),
				),
		});
	});
}

/**
 * Deletes everything a space holds: its asks and their threads, its tickets, and the files its
 * uploads stored. Inboxes watching it are closed, and it carries on as an empty space. For a host
 * removing a tenant; no request can reach it. Running it again finishes what a failed run left.
 */
export const eraseSpace = async (env: WorkerBindings, space: string): Promise<void> => {
	const spaces = namespace();
	await spaces.getByName(space).erase();
	await eraseFiles(env.FILES, filesOf(spaces.idFromName(space).toString()));
};

/** Deletes every file under a prefix, a page of listings at a time. */
const eraseFiles = async (files: R2Bucket, prefix: string): Promise<void> => {
	const listed = await files.list({ prefix, limit: 1000 });
	if (listed.objects.length > 0) await files.delete(listed.objects.map(({ key }) => key));
	if (listed.truncated) await eraseFiles(files, prefix);
};
