import { type Caller, operationsOf } from "@loopbacktools/core/rpc";
import { BUILD_HEADER, RELOAD_CODE, REVISION_HEADER } from "@loopbacktools/protocol";
import { openApiDocument } from "@loopbacktools/protocol/document";
import { REVISION } from "@loopbacktools/protocol/schema";
import { Effect } from "effect";
import { type Context, Hono } from "hono";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { type Operations, registerRoutes } from "../generated/app.gen.ts";
import type { AppEnv, RouteDeps } from "../generated/runtime.gen.ts";
import { agentOperations } from "./agent.ts";
import type { Budgets } from "./budgets.ts";
import { coreOf, ready } from "./core.ts";
import { buildOf, type EdgeBindings } from "./env.ts";
import { type Access, Gate } from "./gate.ts";
import { llmsTxt } from "./llms.ts";
import { makeMcp } from "./mcp.ts";
import { problem } from "./problems.ts";
import { answerUnhandled, run, runtimeOf } from "./run.ts";
import { forwardFor, forwardWithTicket, offeredTicket, ticketRefused } from "./sockets.ts";
import { VERSION } from "./version.ts";

declare module "../generated/runtime.gen.ts" {
	interface AppEnv {
		readonly Bindings: EdgeBindings;
		readonly Variables: { readonly requestId: string; readonly access?: Access };
	}
}

/** The contract, naming the release that serves it, so a deployment can be checked from outside. */
const document = { ...openApiDocument, info: { ...openApiDocument.info, version: VERSION } };

/** Who an upload is from: no one the edge knows. The URL is the credential, and the core checks it. */
const ANONYMOUS: Caller = { space: "", actor: { id: "anonymous" } };

/**
 * A refused request's 401. When the gate takes credentials from an authorization server, the
 * challenge says where its protected resource metadata is, so an MCP client can go and sign in.
 */
const unauthorized = (message: string, resourceMetadata?: string) =>
	Response.json(problem("auth.unauthorized", message), {
		status: 401,
		headers: {
			"WWW-Authenticate":
				resourceMetadata === undefined
					? 'Bearer realm="loopback"'
					: `Bearer realm="loopback", resource_metadata="${resourceMetadata}"`,
		},
	});

/** Where the MCP endpoint's protected resource metadata is (RFC 9728): the well-known path, then its path. */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** Who a request is from, or the 401 its refusal is answered with. */
const authenticate = (c: Context<AppEnv>) =>
	run(
		runtimeOf(c.env),
		c.req.raw.signal,
		c.get("requestId"),
		Effect.gen(function* () {
			const gate = yield* Gate;
			return yield* gate
				.authenticate(c.req.raw)
				.pipe(
					Effect.catchTag("Unauthorized", (refused) =>
						Effect.flatMap(gate.authorizationServers, (servers) =>
							Effect.fail(
								unauthorized(
									refused.reason,
									servers.length === 0
										? undefined
										: `${new URL(c.req.url).origin}${RESOURCE_METADATA_PATH}/mcp`,
								),
							),
						),
					),
				);
		}).pipe(Effect.result),
	);

const authorizationServers = (c: Context<AppEnv>) =>
	run(
		runtimeOf(c.env),
		c.req.raw.signal,
		c.get("requestId"),
		Gate.use((gate) => gate.authorizationServers),
	);

/**
 * The handler for each operation the contract declares: the inbox's, straight through to the core,
 * and the agent's, which wait for the person as long as an HTTP call may. A failure is thrown on, to
 * be answered as the deployment's problem.
 */
const handlers = (c: Context<AppEnv>, budgets: Budgets) => {
	const core = coreOf(c.env);
	const signal = c.req.raw.signal;
	return {
		...operationsOf(core),
		Uploads_store: (caller: Caller, input) =>
			core.Uploads_store(caller, {
				spaceId: input.spaceId,
				token: input.token,
				"Content-Type": input["Content-Type"],
				length: input["content-length"] ?? Number.NaN,
				body: input.body,
			}),
		...agentOperations({
			core,
			origin: new URL(c.req.url).origin,
			wait: {
				budgetMs: budgets.waitMs,
				keepAliveMs: budgets.keepAliveMs,
				// An HTTP caller hears nothing until the reply; it is only asked whether it is still there.
				progress: async () => {
					if (signal.aborted) throw new Error("The caller stopped waiting.");
				},
			},
			failed: (error) => {
				throw error;
			},
		}),
	} satisfies Operations<Caller>;
};

const deps: RouteDeps<AppEnv, Caller> = {
	authorize: (requirements) => async (c, next) => {
		// Every gated operation asks for a bearer token and nothing else; the gate decides what one is.
		if (!requirements.some((requirement) => "BearerAuth" in requirement)) {
			return unauthorized("This operation accepts no credentials Loopback can check.");
		}
		const access = await authenticate(c);
		if (access._tag === "Failure") return access.failure;
		c.set("access", access.success);
		await next();
		return undefined;
	},
	context: (c, authentication) => {
		if (authentication === "none") return ANONYMOUS;
		return c.get("access") ?? null;
	},
	noContext: () => unauthorized("A bearer token is required."),
	notAcceptable: (c, offered) =>
		c.json(problem("request.not_acceptable", `This responds with ${offered.join(", ")}.`), 406),
	invalid: (result, c) =>
		result.success
			? undefined
			: c.json(problem("request.invalid", "The request does not match the API contract."), 400),
};

/**
 * The edge's surface: the contract's routes, the event socket, the document that describes them, and
 * the MCP endpoint agents connect to, each in front of the core.
 */
export const makeApp = (budgets: Budgets) => {
	const app = new Hono<AppEnv>({ router: new RegExpRouter() });
	const mcp = makeMcp(budgets);

	// Middleware before `registerRoutes`: Hono applies it only to routes registered after it.
	app.use(async (c, next) => {
		c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
		await next();
	});
	// Nothing the edge answers is to be sniffed as another type. Everything names the code that
	// answered, so a client can tell when Loopback has been updated under it. A WebSocket's 101 is the
	// space's own response, and is left as it is.
	app.use(async (c, next) => {
		await next();
		if (c.res.status === 101) return;
		// A response the core sent through the binding, as a refused socket is, can't have its headers
		// changed, so each answer is one of the edge's own.
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set("X-Content-Type-Options", "nosniff");
		c.res.headers.set("Referrer-Policy", "no-referrer");
		c.res.headers.set(REVISION_HEADER, String(REVISION));
		const build = buildOf(c.env);
		if (build !== undefined) c.res.headers.set(BUILD_HEADER, build);
	});
	// An edge with no core can answer nothing.
	app.use(async (c, next) => {
		coreOf(c.env);
		await next();
	});
	// A client writing a later revision of the contract than this code reads is from newer code, as a
	// page loaded before a rollback is: it is refused before anything runs, and reloads onto this code.
	app.use(async (c, next) => {
		if (Number(c.req.header(REVISION_HEADER)) > REVISION) {
			return c.json(
				problem(
					RELOAD_CODE,
					"This is from a newer version of Loopback than the server. Reload it.",
				),
				409,
			);
		}
		await next();
		return undefined;
	});
	app.onError((error, c) => answerUnhandled(error, c.get("requestId")));
	app.notFound((c) => c.json(problem("not_found", "No such route."), 404));

	app.get("/api/v1/openapi.json", (c) => c.json(document));

	// Everything else under the API reaches the core, which must speak this edge's revision.
	app.use("/api/v1/*", async (c, next) => {
		await ready(coreOf(c.env));
		await next();
	});

	// Protected resource metadata for the MCP endpoint, when the gate takes credentials from an
	// authorization server: clients find it at the well-known path or under it, by the resource's path.
	const protectedResource = async (c: Context<AppEnv>) => {
		const servers = await authorizationServers(c);
		if (servers.length === 0) return c.json(problem("not_found", "No such route."), 404);
		return c.json({
			resource: `${new URL(c.req.url).origin}/mcp`,
			authorization_servers: servers,
			bearer_methods_supported: ["header"],
			resource_name: "Loopback",
		});
	};
	app.get(RESOURCE_METADATA_PATH, protectedResource);
	app.get(`${RESOURCE_METADATA_PATH}/mcp`, protectedResource);

	// How an agent connects itself and uses Loopback, for the way this deployment's agents sign in.
	app.get("/llms.txt", async (c) => {
		const servers = await authorizationServers(c);
		return c.text(llmsTxt(new URL(c.req.url).origin, servers.length === 0 ? "token" : "oauth"));
	});

	app.get("/api/v1/events", async (c) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
			return c.json(problem("events.upgrade_required", "Connect with a WebSocket."), 426);
		}
		const core = coreOf(c.env);
		// A browser's one-time pass, spent against the space it names.
		const ticket = offeredTicket(c.req.raw);
		if (ticket !== undefined) return forwardWithTicket(core, c.req.raw, ticket);
		const access = await authenticate(c);
		if (access._tag === "Failure") {
			return access.failure.status === 401
				? ticketRefused("A bearer token or an event ticket is required.")
				: access.failure;
		}
		return forwardFor(core, c.req.raw, access.success);
	});

	app.all("/mcp", async (c) => {
		const access = await authenticate(c);
		if (access._tag === "Failure") return access.failure;
		return mcp(c.req.raw, {
			core: coreOf(c.env),
			caller: access.success,
			origin: new URL(c.req.url).origin,
			requestId: c.get("requestId"),
		});
	});

	return registerRoutes(app, (c) => handlers(c, budgets), deps);
};
