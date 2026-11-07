import type { ServerEvent } from "@loopbacktools/protocol";
import { Context, Effect, FiberMap, Layer } from "effect";

/** How long an ask still shows an agent following it after its last lap or poll. */
export const PRESENCE_GRACE_MS = 10_000;

/**
 * Which asks an agent is polling as a background task. An ask stays followed for
 * `PRESENCE_GRACE_MS` after the last poll ends; if none comes by then, the agent has gone. That
 * grace is a fiber per ask, so a poll that begins in time cancels it. An agent blocked on an ask
 * holds a wait socket instead, which the host counts.
 */
export class Presence extends Context.Service<
	Presence,
	{
		readonly isWaiting: (askId: string) => boolean;
		/** A lap or poll begins. True when that starts the ask being followed. */
		readonly begin: (askId: string) => Effect.Effect<boolean>;
		/** A lap or poll ends; `whenGone` runs if no other begins within the grace. */
		readonly end: <R>(
			askId: string,
			whenGone: Effect.Effect<void, never, R>,
		) => Effect.Effect<void, never, R>;
		/** The agent has said it stopped following: no grace. True when that ends the following. */
		readonly drop: (askId: string) => Effect.Effect<boolean>;
	}
>()("loopback/Presence") {
	static readonly layer = Layer.effect(
		Presence,
		Effect.gen(function* () {
			const laps = new Map<string, number>();
			// Asks in their grace: still shown as followed until their timer fires or a lap begins.
			const leaving = new Set<string>();
			const timers = yield* FiberMap.make<string>();
			const isWaiting = (askId: string) => laps.has(askId) || leaving.has(askId);
			return Presence.of({
				isWaiting,
				begin: (askId) =>
					Effect.gen(function* () {
						const was = isWaiting(askId);
						leaving.delete(askId);
						yield* FiberMap.remove(timers, askId);
						laps.set(askId, (laps.get(askId) ?? 0) + 1);
						return !was;
					}),
				end: (askId, whenGone) =>
					Effect.gen(function* () {
						const left = (laps.get(askId) ?? 1) - 1;
						if (left > 0) {
							laps.set(askId, left);
							return;
						}
						laps.delete(askId);
						leaving.add(askId);
						yield* FiberMap.run(
							timers,
							askId,
							Effect.sleep(PRESENCE_GRACE_MS).pipe(
								Effect.andThen(
									Effect.suspend(() => {
										leaving.delete(askId);
										return whenGone;
									}),
								),
							),
						);
					}),
				drop: (askId) =>
					Effect.gen(function* () {
						if (laps.has(askId) || !leaving.delete(askId)) return false;
						yield* FiberMap.remove(timers, askId);
						return true;
					}),
			});
		}),
	);
}

/** What the space's operations need from the object that hosts them. */
export class Host extends Context.Service<
	Host,
	{
		/** Sends an event to every connected inbox. */
		readonly broadcast: (event: ServerEvent) => Effect.Effect<void>;
		/** Tells every agent waiting on the ask that a reply landed, for it to take. */
		readonly wake: (askId: string) => Effect.Effect<void>;
		/** How many agents hold a wait on the ask right now. */
		readonly waiters: (askId: string) => number;
		/** The DO id, which upload URLs name the space by. */
		readonly spaceId: string;
	}
>()("loopback/Host") {}
