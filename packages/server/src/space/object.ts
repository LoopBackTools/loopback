import { SqliteClient } from "@effect/sql-sqlite-do";
import type { ServerEvent } from "@loopbackhq/protocol";
import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Layer, Logger, ManagedRuntime } from "effect";
import { migrations } from "./migrations.ts";
import { operations, snapshot } from "./operations.ts";
import {
	BUILD_HEADER,
	buildOf,
	type Caller,
	encodeExit,
	type ExitJson,
	isLater,
	type OperationName,
	Outdated,
	type SpaceFailure,
} from "./rpc.ts";
import { Host, Presence, Replies } from "./services.ts";
import { AskStore, TicketStore, UploadStore } from "./store.ts";

/** The subprotocol an inbox speaks on the event socket. */
export const EVENTS_PROTOCOL = "loopback.v1";

/** How long a space that has refused newer code waits before restarting: long enough to answer. */
const RESTART_DELAY_MS = 100;

type SpaceServices = AskStore | UploadStore | TicketStore | Host | Replies | Presence;

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
				spaceId: this.ctx.id.toString(),
			}),
		);
		return ManagedRuntime.make(
			Layer.mergeAll(AskStore.layer, UploadStore.layer, TicketStore.layer, migrations).pipe(
				Layer.provide(sql),
				Layer.merge(Layer.mergeAll(host, Replies.layer, Presence.layer)),
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
	 * newer Worker calls it. Called by newer code, it refuses, running nothing, and restarts onto that
	 * code a moment later, once the refusal is on its way; whatever reaches it until then is refused
	 * the same way. A caller retries what was refused. Older code calling a newer space carries on.
	 */
	#outdatedFor(build: string | undefined): boolean {
		if (!this.#restarting && !isLater(build, this.#ownBuild)) return false;
		if (!this.#restarting) {
			this.#restarting = true;
			setTimeout(
				() => this.ctx.abort("Newer code called this space: restarting onto it."),
				RESTART_DELAY_MS,
			);
		}
		return true;
	}

	/** Runs one space operation and answers with its Exit, encoded for the trip back. */
	async call(method: OperationName, args: readonly unknown[], caller?: Caller): Promise<ExitJson> {
		// Code from before callers named their version passes nothing: it is older, so carry on.
		if (this.#outdatedFor(caller?.build)) return encodeExit(Exit.fail(new Outdated()));
		if (!Object.hasOwn(operations, method)) {
			return encodeExit(
				await Effect.runPromiseExit(Effect.die(new Error(`No operation ${method}`))),
			);
		}
		const operation = operations[method] as (
			...args: readonly unknown[]
		) => Effect.Effect<unknown, SpaceFailure, SpaceServices>;
		return encodeExit(await this.#runtime.runPromiseExit(operation(...args)));
	}

	/** Accepts an inbox's event socket and sends it the space as it stands. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}
		// The inbox reconnects, by then to the space on the new code.
		if (this.#outdatedFor(request.headers.get(BUILD_HEADER) ?? undefined)) {
			return new Response("This space is restarting onto newer code.", {
				status: 503,
				headers: { "Retry-After": "1" },
			});
		}
		// Read the space first: a socket is only accepted once there is something to send it.
		const current = await this.#runtime.runPromise(snapshot);
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
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
	 * Inboxes only send keep-alive pings, which the auto-response answers without waking us. Closing
	 * needs no handler: the runtime completes the close handshake itself.
	 */
	override async webSocketMessage(): Promise<void> {}

	#broadcast(event: ServerEvent): Effect.Effect<void> {
		return Effect.sync(() => {
			const frame = JSON.stringify(event);
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send(frame);
				} catch {
					// A socket that is closing misses the frame; it gets a fresh snapshot on reconnect.
				}
			}
		});
	}
}
