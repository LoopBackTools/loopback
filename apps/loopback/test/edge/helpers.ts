import type { Core } from "@loopbacktools/core";
import type { Ask, Reply } from "@loopbacktools/protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import edge, { type EdgeOptions, makeEdge } from "../../src/edge/worker.ts";

export const ORIGIN = "https://loopback.test";
export const BASE = `${ORIGIN}/api/v1`;

/** The two people the test deployment's `LOOPBACK_TOKENS` lets in, by their tokens. */
export const TOKENS = JSON.parse(env.LOOPBACK_TOKENS) as {
	readonly owner: string;
	readonly ada: string;
};

/** The core as the edge reaches it, for setting up and looking at what the edge did. */
export const core = () => env.CORE as Service<Core>;

/** Who the owner's token calls as, as the core is told. */
export const OWNER = { space: "default", actor: { id: "owner", name: "owner" } } as const;

/** Settings that replace the test deployment's own: a binding left out, or a setting changed. */
export type Settings = Readonly<Record<string, unknown>>;

/**
 * Calls the edge through its real `fetch`: the test Worker's own default export, or the edge with
 * some settings replaced, or built with other options, each as a deployment of its own.
 */
export const fetchEdge = async (
	url: string,
	init: RequestInit = {},
	options: { readonly settings?: Settings; readonly edge?: EdgeOptions } = {},
): Promise<Response> => {
	if (options.settings === undefined && options.edge === undefined) {
		return exports.default.fetch(url, init);
	}
	const handler = options.edge === undefined ? edge : makeEdge(options.edge);
	const ctx = createExecutionContext();
	const response = await handler.fetch(
		new Request(url, init),
		{ ...env, ...options.settings } as never,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
};

/** An API call, with the owner's token unless another, or none, is given. */
export const api = (
	path: string,
	init: RequestInit & { readonly token?: string | null; readonly settings?: Settings } = {},
) => {
	const { token = TOKENS.owner, settings, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	return fetchEdge(
		`${BASE}${path}`,
		{ ...rest, headers },
		settings === undefined ? {} : { settings },
	);
};

export const json = (body: unknown, method = "POST") => ({
	method,
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json" },
});

/** The person replies to an ask through the API, as the inbox does. */
export const reply = (askId: string, body: Reply, token: string = TOKENS.owner) =>
	api(`/asks/${askId}/reply`, { ...json(body), token });

/** Clients speak either protocol era: the 2025 handshake, or 2026-07-28 with a per-request envelope. */
export type Era = "legacy" | "auto";

/** An MCP client connected to the edge's `/mcp`, as an agent connects. */
export const connect = async (
	options: {
		readonly token?: string;
		readonly mode?: Era;
		readonly name?: string;
		readonly settings?: Settings;
		readonly edge?: EdgeOptions;
	} = {},
) => {
	const client = new Client(
		{ name: options.name ?? "loopback-test", version: "1.0.0" },
		{ versionNegotiation: { mode: options.mode ?? "auto" } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			fetch: (url, init) =>
				fetchEdge(String(url), init, {
					...(options.settings === undefined ? {} : { settings: options.settings }),
					...(options.edge === undefined ? {} : { edge: options.edge }),
				}),
			requestInit: { headers: { Authorization: `Bearer ${options.token ?? TOKENS.owner}` } },
		}),
	);
	return client;
};

export const textOf = (result: { readonly content?: unknown }) =>
	Array.isArray(result.content)
		? result.content.map((part: { readonly text?: string }) => part.text ?? "").join("\n")
		: "";

/** The open ask in the owner's space matching `test`, once it appears. */
export const opened = async (
	test: (ask: Ask) => boolean,
	caller: { readonly space: string; readonly actor: { readonly id: string } } = OWNER,
): Promise<Ask> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const snapshot = await core().Snapshots_read(caller, {});
		const found = snapshot.body.open.find(test);
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The ask never opened.");
};

/** A question opened through the core, not waited on, for tests about everything after. */
export const question = async (text: string) => {
	const outcome = await core().askQuestion(OWNER, {
		question: text,
		options: [{ label: "Yes" }, { label: "No" }],
		project: "edge-test",
	});
	if (outcome.outcome !== "started") throw new Error(`The question was ${outcome.outcome}.`);
	return outcome.askId;
};
