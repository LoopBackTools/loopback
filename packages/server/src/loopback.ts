import type { Layer } from "effect";
import { type Budgets, budgetsFor, type Plan } from "./budgets.ts";
import type { LoopbackBindings, WorkerBindings, WorkerEnv } from "./worker/env.ts";
import type { Gate } from "./worker/gate.ts";
import { Limits } from "./worker/limits.ts";
import { makeApp } from "./worker/http.ts";
import { defaultInboxUrl, type InboxLink } from "./worker/mcp.ts";
import { runtimes } from "./worker/run.ts";
import { Spaces } from "./worker/spaces.ts";

export interface LoopbackOptions {
	/** Decides who each request is from and which space it opens. */
	readonly gate: Layer.Layer<Gate, never, WorkerEnv>;
	/**
	 * How requests reach their spaces. The Worker's own `Space` objects unless said otherwise: a host
	 * wraps `Spaces.layer` to meter what its tenants open, or to decline it with a reason.
	 */
	readonly spaces?: Layer.Layer<Spaces, never, WorkerEnv>;
	/**
	 * Whether each request may go on, once its caller is known: `rateLimit` limits each space's
	 * requests with a Rate Limiting binding. A refused caller is answered with a 429 and
	 * `Retry-After`. No limits unless said otherwise.
	 */
	readonly limits?: Layer.Layer<Limits, never, WorkerEnv>;
	/**
	 * Where the person reads and answers a space's asks, which `open_inbox` gives agents. This
	 * Worker's own inbox unless said otherwise: a host whose frontend lives elsewhere, or routes by
	 * space, says where.
	 */
	readonly inboxUrl?: (link: InboxLink) => string;
	/**
	 * Which Workers plan the deployment runs on, which sets what it spends on waiting agents
	 * (`Budgets`). Free holds each request to 10 ms of CPU, so a blocking call waits a while, then
	 * asks the agent to call again, and tasks are polled less often. `"paid"` unless said otherwise:
	 * a wait lasts until the reply.
	 */
	readonly plan?: Plan;
	/** Any of the plan's budgets the deployment sets itself. */
	readonly budgets?: Partial<Budgets>;
}

/**
 * A Loopback Worker's `fetch` handler. The deployment exports it as its default, beside the `Space`
 * Durable Object class declared with SQLite storage, and binds `FILES`.
 */
export const createLoopback = (options: LoopbackOptions) => {
	const app = makeApp(
		runtimes(options.gate, options.spaces ?? Spaces.layer, options.limits ?? Limits.none),
		options.inboxUrl ?? defaultInboxUrl,
		budgetsFor(options.plan ?? "paid", options.budgets),
	);
	return {
		// Any environment that declares Loopback's bindings: the host's own type, such as the one
		// `wrangler types` writes, need not say it holds nothing else.
		fetch: (request: Request, env: LoopbackBindings, ctx: ExecutionContext) =>
			app.fetch(request, env as unknown as WorkerBindings, ctx),
	} satisfies ExportedHandler<LoopbackBindings>;
};
