import type { ServerEvent } from "@loopbacktools/protocol";
import { Context, type Effect } from "effect";

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
		/**
		 * Wakes the space at `at` to tell inboxes about followings that ran out, unless it is already
		 * to wake sooner. An alarm, not a timer, so the space can hibernate meanwhile.
		 */
		readonly scheduleAlarm: (at: string) => Effect.Effect<void>;
		/** The DO id, which upload URLs name the space by. */
		readonly spaceId: string;
	}
>()("loopback/Host") {}
