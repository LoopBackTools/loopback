/** Which Workers plan a deployment runs on: Free holds each request to 10 ms of CPU. */
export type Plan = "free" | "paid";

/** What a deployment spends on an agent that waits. Free and Paid differ only in these. */
export interface Budgets {
	/**
	 * How long one blocking call waits for a reply before it answers "no reply yet: call again",
	 * which rejoins the ask. Each lap of a wait costs CPU, which Free limits per request.
	 */
	readonly waitMs: number;
	/** How often a waiting call tells its client it is alive, and how often the MCP stream keeps alive. */
	readonly keepAliveMs: number;
}

/**
 * The longest keep-alive. A client's request times out after 60 s with no progress notification
 * (SSE comments don't count), and the network closes a response silent for about 5 minutes.
 */
export const MAX_KEEP_ALIVE_MS = 50_000;

export const PLANS: Readonly<Record<Plan, Budgets>> = {
	paid: { waitMs: Infinity, keepAliveMs: 25_000 },
	free: { waitMs: 600_000, keepAliveMs: 25_000 },
};

/** The plan a deployment's `LOOPBACK_PLAN` names: Paid when it says `paid`, Free otherwise. */
export const planOf = (setting: string | undefined): Plan =>
	setting?.trim().toLowerCase() === "paid" ? "paid" : "free";

const positive = (name: string, value: number) => {
	if (!(value > 0)) throw new Error(`Loopback's ${name} budget must be a positive number of ms.`);
};

/** A plan's budgets, with any the deployment overrides. */
export const budgetsFor = (plan: Plan, overrides: Partial<Budgets> = {}): Budgets => {
	const budgets = { ...PLANS[plan], ...overrides };
	positive("waitMs", budgets.waitMs);
	positive("keepAliveMs", budgets.keepAliveMs);
	if (budgets.keepAliveMs > MAX_KEEP_ALIVE_MS) {
		throw new Error(
			`Loopback's keepAliveMs budget is at most ${MAX_KEEP_ALIVE_MS} ms: a client gives up after 60 s without progress.`,
		);
	}
	return budgets;
};
