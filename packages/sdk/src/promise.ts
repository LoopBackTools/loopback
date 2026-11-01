import type { Reply as ReplyBody } from "@loopbacktools/protocol";
import type { Ask, AskPage, Snapshot, Whoami } from "@loopbacktools/protocol/schema";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { type ApiError, type LoopbackConfig, make, type Update } from "./client.ts";
import { type InboxState, initialInbox } from "./inbox.ts";

/** A value kept live as an external store: the shape React's `useSyncExternalStore` takes, and any other framework can. */
export interface Store<A> {
	/** Starts following the value with the first listener and stops after the last leaves. */
	readonly subscribe: (listener: () => void) => () => void;
	/** The current value. The same object until something changes. */
	readonly getSnapshot: () => A;
}

/** The inbox as an external store. */
export type InboxStore = Store<InboxState>;

/** The Loopback client for code that does not use Effect: every call is a promise. */
export interface LoopbackPromiseClient {
	readonly whoami: () => Promise<Whoami>;
	readonly snapshot: () => Promise<Snapshot>;
	readonly ask: (id: string) => Promise<Ask>;
	readonly history: (page?: {
		readonly before?: string;
		readonly limit?: number;
	}) => Promise<AskPage>;
	readonly reply: (id: string, reply: ReplyBody) => Promise<Ask>;
	readonly file: (uploadId: string) => Promise<Blob>;
	/** How an agent signs in to this deployment's MCP endpoint: see `LoopbackApi`. */
	readonly agentSignIn: () => Promise<"oauth" | "token">;
	readonly inbox: InboxStore;
	/** Whether Loopback has been updated under this client: see `Update`. */
	readonly update: Store<Update>;
}

/** Runs a call, rejecting with the `ApiError` itself so callers can match on it. */
const settle = async <A>(effect: Effect.Effect<A, ApiError>): Promise<A> => {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
};

/** A stream followed while anything listens, starting over from `initial` each time it is followed anew. */
const storeOf = <A>(stream: Stream.Stream<A>, initial: A): Store<A> => {
	const listeners = new Set<() => void>();
	let state = initial;
	let following: Fiber.Fiber<void> | undefined;
	return {
		subscribe: (listener) => {
			listeners.add(listener);
			following ??= Effect.runFork(
				stream.pipe(
					Stream.runForEach((next) =>
						Effect.sync(() => {
							state = next;
							for (const notify of listeners) notify();
						}),
					),
				),
			);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0 && following !== undefined) {
					Effect.runFork(Fiber.interrupt(following));
					following = undefined;
					state = initial;
				}
			};
		},
		getSnapshot: () => state,
	};
};

export const createLoopbackClient = (config: LoopbackConfig): LoopbackPromiseClient => {
	const api = make(config);
	const inbox = storeOf(api.inbox, initialInbox);
	const update = storeOf(api.update, "none");

	return {
		whoami: () => settle(api.whoami),
		snapshot: () => settle(api.snapshot),
		ask: (id) => settle(api.ask(id)),
		history: (page) => settle(api.history(page)),
		reply: (id, reply) => settle(api.reply(id, reply)),
		file: (uploadId) => settle(api.file(uploadId)),
		agentSignIn: () => settle(api.agentSignIn),
		inbox,
		update,
	};
};
