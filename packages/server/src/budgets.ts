import { POLL_INTERVALS, type PollIntervals } from "./domain/polling.ts";

/** Which Workers plan a deployment runs on: Free holds each request to 10 ms of CPU. */
export type Plan = "free" | "paid";

/**
 * What a deployment spends on an agent that waits. Free and Paid differ only in these: everything
 * else Loopback does is the same on both.
 */
export interface Budgets {
	/**
	 * How long one blocking tool call waits for a reply before it returns "no reply yet: call again".
	 * The call again rejoins the ask. Each lap of a wait costs CPU, which Free limits per request.
	 */
	readonly waitMs: number;
	/** How often a waiting call pings its space and tells the client it is alive, and SSE keep-alives. */
	readonly keepAliveMs: number;
	/** How often a client should poll a background task: under 2 minutes old, under 30, after. */
	readonly pollMs: PollIntervals;
}

/**
 * The longest keep-alive. A client's request times out after 60 s with no progress notification
 * (SSE comments don't count), and the edge closes a response silent for about 5 minutes.
 */
export const MAX_KEEP_ALIVE_MS = 50_000;

export const PLANS: Readonly<Record<Plan, Budgets>> = {
	// A wait lasts until the reply, and tasks are polled as before. The keep-alive is the 25 s lap a
	// wait always had; SSE keep-alives, the SDK's 15 s before 0.7.0, follow it.
	paid: { waitMs: Infinity, keepAliveMs: 25_000, pollMs: POLL_INTERVALS },
	free: { waitMs: 600_000, keepAliveMs: 25_000, pollMs: [5_000, 15_000, 30_000] },
};

const positive = (name: string, value: number) => {
	if (!(value > 0)) throw new Error(`Loopback's ${name} budget must be a positive number of ms.`);
};

/** A plan's budgets, with any the deployment overrides. */
export const budgetsFor = (plan: Plan, overrides: Partial<Budgets> = {}): Budgets => {
	const budgets = { ...PLANS[plan], ...overrides };
	positive("waitMs", budgets.waitMs);
	positive("keepAliveMs", budgets.keepAliveMs);
	for (const interval of budgets.pollMs) positive("pollMs", interval);
	if (budgets.keepAliveMs > MAX_KEEP_ALIVE_MS) {
		throw new Error(
			`Loopback's keepAliveMs budget is at most ${MAX_KEEP_ALIVE_MS} ms: a client gives up after 60 s without progress.`,
		);
	}
	return budgets;
};
