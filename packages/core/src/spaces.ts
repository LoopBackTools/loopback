import { BUILD_HEADER, REVISION_HEADER } from "@loopbacktools/protocol";
import { Context, Data, Effect, Layer, Option, Queue, type Scope } from "effect";
import { AskNotFound } from "./domain/errors.ts";
import type { Space } from "./space/object.ts";
import {
	REPLY_FRAME,
	type SpaceClient,
	spaceClient,
	type Caller as Version,
	waitPath,
} from "./space/rpc.ts";

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

/** Reaches the core's spaces, by name, as callers open them, or by object id, as URLs name them. */
export class Spaces extends Context.Service<
	Spaces,
	{
		readonly of: (space: string) => SpaceClient;
		/** The object id of a space: how uploads, files and event tickets name it. */
		readonly idOf: (space: string) => string;
		/** A space by its object id. None when the id is not one this core minted. */
		readonly byId: (spaceId: string) => Option.Option<SpaceClient>;
		/** Hands an inbox's WebSocket upgrade to the space with this object id. */
		readonly connect: (spaceId: string, request: Request) => Effect.Effect<Response>;
		/**
		 * Opens an agent's wait on an ask, closed when its scope closes. The space can hibernate
		 * while the wait is open, and wakes it when a reply lands.
		 */
		readonly wait: (
			space: string,
			askId: string,
			afterSeq: number,
		) => Effect.Effect<Waiter, AskNotFound | SpaceUnavailable, Scope.Scope>;
		/** Deletes a space's asks, threads and tickets, and closes the inboxes watching it. */
		readonly erase: (space: string) => Effect.Effect<void>;
	}
>()("loopback/Spaces") {
	/**
	 * The core's `Space` objects, called as code of `version`, so a space still on older code knows
	 * to restart.
	 */
	static readonly layer = (spaces: DurableObjectNamespace<Space>, version: Version) =>
		Layer.sync(Spaces, () => {
			const stubOf = (space: string) => spaces.getByName(space);
			/** A request to a space, named by this code alone, whatever it brought with it. */
			const named = (request: Request) => {
				const copy = new Request(request);
				copy.headers.set(REVISION_HEADER, String(version.revision));
				if (version.build === undefined) copy.headers.delete(BUILD_HEADER);
				else copy.headers.set(BUILD_HEADER, version.build);
				return copy;
			};
			return Spaces.of({
				of: (space) => spaceClient(() => stubOf(space), version),
				idOf: (space) => spaces.idFromName(space).toString(),
				byId: (spaceId) => {
					if (!/^[0-9a-f]{64}$/.test(spaceId)) return Option.none();
					try {
						const id = spaces.idFromString(spaceId);
						return Option.some(spaceClient(() => spaces.get(id), version));
					} catch {
						// A well-formed id this namespace did not mint.
						return Option.none();
					}
				},
				connect: (spaceId, request) =>
					Effect.promise(() => spaces.get(spaces.idFromString(spaceId)).fetch(named(request))),
				wait: (space, askId, afterSeq) =>
					Effect.acquireRelease(
						Effect.gen(function* () {
							const upgrade = new Request(`http://space${waitPath(askId, afterSeq)}`, {
								headers: { Upgrade: "websocket" },
							});
							const response = yield* Effect.tryPromise({
								try: () => stubOf(space).fetch(named(upgrade)),
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
				erase: (space) => Effect.promise(() => stubOf(space).erase()),
			});
		});
}
