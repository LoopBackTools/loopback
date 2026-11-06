import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "@effect/vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ConfiguredGate, createLoopback, DEFAULT_SPACE, rateLimit } from "../src/index.ts";

const ORIGIN = "https://loopback.test";

/** A rate limiter that refuses the keys in `refused`, and records every key it is asked about. */
const limiter = (refused: Set<string>) => {
	const keys: string[] = [];
	const binding = {
		limit: async ({ key }: { key: string }) => {
			keys.push(key);
			return { success: !refused.has(key) };
		},
	};
	return { binding: binding as unknown as RateLimit, keys };
};

const limited = (binding: RateLimit) =>
	createLoopback({
		gate: ConfiguredGate,
		limits: rateLimit(() => ({ limiter: binding, retryAfter: 60 })),
	});

const whoami = (app: ReturnType<typeof createLoopback>) =>
	app.fetch(
		new Request(`${ORIGIN}/api/v1/whoami`, {
			headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}` },
		}),
		{ ...env },
		createExecutionContext(),
	);

describe("a deployment that limits each space's requests", () => {
	it("refuses a limited space's API request with a 429 and Retry-After", async () => {
		const response = await whoami(limited(limiter(new Set([DEFAULT_SPACE])).binding));
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(((await response.json()) as { code: string }).code).toBe("request.rate_limited");
	});

	it("tells an MCP client why it was refused", async () => {
		const refused = new Set<string>();
		const app = limited(limiter(refused).binding);
		const client = new Client({ name: "limits-test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
				fetch: async (url, init) =>
					app.fetch(new Request(url, init), { ...env }, createExecutionContext()),
				requestInit: { headers: { Authorization: `Bearer ${env.LOOPBACK_TOKEN}` } },
			}),
		);
		refused.add(DEFAULT_SPACE);
		await expect(
			client.callTool({
				name: "ask_question",
				arguments: { question: "Ship it?", project: "limits" },
			}),
		).rejects.toThrow(/Too many requests for this workspace/);
		await client.close();
	});

	it("limits each space on its own", async () => {
		const response = await whoami(limited(limiter(new Set(["other"])).binding));
		expect(response.status).toBe(200);
	});

	it("admits when the limiter fails", async () => {
		const failing = {
			limit: async () => {
				throw new Error("The rate limiter is unavailable.");
			},
		} as unknown as RateLimit;
		expect((await whoami(limited(failing))).status).toBe(200);
	});

	it("admits everything without limits", async () => {
		expect((await whoami(createLoopback({ gate: ConfiguredGate }))).status).toBe(200);
	});

	it("keys the limiter by the space", async () => {
		const { binding, keys } = limiter(new Set());
		await whoami(limited(binding));
		expect(keys).toEqual([DEFAULT_SPACE]);
	});
});
