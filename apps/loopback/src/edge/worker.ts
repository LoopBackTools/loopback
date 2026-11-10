import { type Budgets, budgetsFor, planOf } from "./budgets.ts";
import type { EdgeBindings } from "./env.ts";
import { makeApp } from "./http.ts";

/** How an edge is built: any of its plan's budgets it sets itself. */
export interface EdgeOptions {
	readonly budgets?: Partial<Budgets>;
}

/**
 * The public edge: the contract's routes and MCP tools in front of the core, behind the gate the
 * deployment's settings choose. What it spends on a waiting agent follows `LOOPBACK_PLAN`.
 */
export const makeEdge = (options: EdgeOptions = {}) => {
	const apps = new Map<string, ReturnType<typeof makeApp>>();
	const appFor = (budgets: Budgets) => {
		const key = `${budgets.waitMs}/${budgets.keepAliveMs}`;
		let app = apps.get(key);
		if (app === undefined) {
			app = makeApp(budgets);
			apps.set(key, app);
		}
		return app;
	};
	return {
		fetch: (request: Request, env: EdgeBindings, ctx: ExecutionContext) =>
			appFor(budgetsFor(planOf(env.LOOPBACK_PLAN), options.budgets)).fetch(request, env, ctx),
	} satisfies ExportedHandler<EdgeBindings>;
};

export default makeEdge();
