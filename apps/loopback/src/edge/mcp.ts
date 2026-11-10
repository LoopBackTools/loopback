import type { Caller, CoreRpc, Wait } from "@loopbacktools/core/rpc";
import {
	type AuthInfo,
	createMcpHandler,
	McpServer,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerTools } from "../generated/mcp.gen.ts";
import { agentOperations } from "./agent.ts";
import type { Budgets } from "./budgets.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { NotConfigured } from "./problems.ts";
import { incident } from "./run.ts";
import { VERSION } from "./version.ts";

/** What the per-request server needs about the request it serves, once the gate has let it in. */
export interface McpCall {
	readonly core: CoreRpc;
	readonly caller: Caller;
	readonly origin: string;
	readonly requestId: string;
}

const clientInfoSchema = z.object({ name: z.string(), version: z.string().optional() });

/** The MCP client that sent this request, when the request says. */
const clientOf = (context: ServerContext): string | undefined => {
	const envelope: Record<string, unknown> = context.mcpReq.envelope ?? {};
	const meta: Record<string, unknown> = context.mcpReq._meta ?? {};
	const parsed = clientInfoSchema.safeParse(
		envelope["io.modelcontextprotocol/clientInfo"] ?? meta["io.modelcontextprotocol/clientInfo"],
	);
	if (!parsed.success) return undefined;
	return parsed.data.version === undefined
		? parsed.data.name
		: `${parsed.data.name} ${parsed.data.version}`;
};

/**
 * How long a tool call waits for the person, and how the core tells its client it is alive: a
 * progress notification every lap, which keeps the client's idle timer from giving up on a long wait.
 * Once the client has gone, the next lap rejects, and the core stops waiting.
 */
const waitOf = (context: ServerContext, budgets: Budgets): Wait => ({
	budgetMs: budgets.waitMs,
	keepAliveMs: budgets.keepAliveMs,
	progress: async (step) => {
		if (context.mcpReq.signal.aborted) throw new Error("The agent stopped waiting.");
		const progressToken = context.mcpReq._meta?.progressToken;
		if (progressToken === undefined) return;
		await context.mcpReq.notify({
			method: "notifications/progress",
			params: { progressToken, progress: step, message: "Waiting for the person to reply" },
		});
	},
});

/**
 * A call that failed tells the agent what to do when a setting is the cause, and otherwise only the
 * incident to quote, logged under the request's id: never Loopback's internals.
 */
const failedFor =
	(requestId: string) =>
	(error: unknown): never => {
		throw new Error(error instanceof NotConfigured ? error.message : incident(error, requestId));
	};

/**
 * The MCP endpoint: the contract's agent operations, as the tools generated from it, on a server
 * built for each request. The gate runs first; who it let in reaches the server through the
 * `authInfo` the SDK passes along untouched. No tool returns a background task yet: every call waits
 * for the reply, with progress, until the tool emitter supports MCP Tasks.
 */
export const makeMcp = (budgets: Budgets) => {
	const calls = new WeakMap<AuthInfo, McpCall>();
	const handler = createMcpHandler(
		(context) => {
			const call = context.authInfo === undefined ? undefined : calls.get(context.authInfo);
			if (call === undefined) throw new Error("An MCP request reached the server without access.");
			const server = new McpServer(
				{ name: "loopback", version: VERSION },
				{ instructions: INSTRUCTIONS },
			);
			// Loopback's tools never change, and it publishes nothing else, so a client's
			// `subscriptions/listen` is acknowledged and closed at once rather than held open for hours.
			// Declared before the first tool: the SDK fills in `listChanged: true` only when it is unset.
			server.server.registerCapabilities({ tools: { listChanged: false } });
			registerTools(
				server,
				(serverContext) => {
					const client = clientOf(serverContext);
					return agentOperations({
						core: call.core,
						origin: call.origin,
						...(client === undefined ? {} : { client }),
						wait: waitOf(serverContext, budgets),
						failed: failedFor(call.requestId),
					});
				},
				{
					// The gate has already let the caller in, and every tool is open to everyone it lets in.
					permits: () => true,
					context: () => call.caller,
					noContext: () => ({
						content: [{ type: "text", text: "A bearer token is required." }],
						isError: true,
					}),
				},
			);
			return server;
		},
		// Always stream, so a long wait starts its response at once and keep-alive frames flow.
		{ responseMode: "sse", keepAliveMs: budgets.keepAliveMs },
	);
	return (request: Request, call: McpCall) => {
		const authInfo: AuthInfo = { token: "", clientId: call.caller.actor.id, scopes: [] };
		calls.set(authInfo, call);
		return handler.fetch(request, { authInfo });
	};
};
