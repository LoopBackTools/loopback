import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, connect, fetchEdge, ORIGIN, textOf, TOKENS } from "./helpers.ts";

describe("an edge with no core bound", () => {
	it("answers every request with a 500 that names CORE", async () => {
		for (const [path, method] of [
			["/mcp", "POST"],
			["/api/v1/whoami", "GET"],
			["/api/v1/openapi.json", "GET"],
			["/llms.txt", "GET"],
		] as const) {
			const response = await fetchEdge(
				`${ORIGIN}${path}`,
				{ method, headers: { Authorization: `Bearer ${TOKENS.owner}` } },
				{ settings: { CORE: undefined } },
			);
			expect(response.status, path).toBe(500);
			expect(await response.json(), path).toEqual({
				code: "server.not_configured",
				message: "CORE is not bound: deploy loopback-core and bind it as CORE (entrypoint Core).",
			});
		}
	});
});

describe("an edge newer than its core", () => {
	const older = { CORE: env.OLD_CORE };
	const deployCoreFirst = "This Loopback core is older than its edge: deploy loopback-core first.";

	it("tells the agent to deploy loopback-core first, within seconds", async () => {
		const client = await connect({ settings: older });
		const started = Date.now();
		const result = await client.callTool({
			name: "ask_question",
			arguments: { question: "Deployed in order?", project: "edge-test" },
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(deployCoreFirst);
		await client.close();
	}, 30_000);

	it("tells an API caller the same, after a few tries", async () => {
		const started = Date.now();
		const response = await api("/whoami", { settings: older });
		expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			code: "server.not_configured",
			message: deployCoreFirst,
		});
	}, 30_000);
});
