import { describe, expect, it } from "vitest";
import { api, connect, opened, reply, TOKENS } from "./helpers.ts";

const ADA = { space: "default", actor: { id: "ada", name: "ada" } } as const;

describe("a deployment's tokens", () => {
	it("lets each person in with their own token", async () => {
		const owner = await api("/whoami", { token: TOKENS.owner });
		expect(owner.status).toBe(200);
		expect(await owner.json()).toEqual({
			space: "default",
			actor: { id: "owner", name: "owner" },
		});
		const ada = await api("/whoami", { token: TOKENS.ada });
		expect(ada.status).toBe(200);
		expect(await ada.json()).toEqual(ADA);
	});

	it("refuses a token not in the map, and a request with none", async () => {
		for (const token of ["b".repeat(64), `${TOKENS.ada}x`, null]) {
			const response = await api("/whoami", { token });
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="loopback"');
			expect(await response.json()).toMatchObject({ code: "auth.unauthorized" });
		}
	});

	it("attributes an ask to the person whose agent raised it, and a reply to whoever gave it", async () => {
		const client = await connect({ token: TOKENS.ada });
		const call = client.callTool({
			name: "ask_question",
			arguments: { question: "Whose is this?", project: "edge-test" },
		});
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === "Whose is this?",
		);
		expect(ask.raisedBy).toEqual(ADA.actor);
		const read = await api(`/asks/${ask.id}`, { token: TOKENS.owner });
		expect(await read.json()).toMatchObject({ raisedBy: ADA.actor });
		expect(
			(await reply(ask.id, { outcome: "answered", selected: [], text: "Ada's." })).status,
		).toBe(200);
		expect((await call).structuredContent).toMatchObject({
			askId: ask.id,
			reply: { outcome: "answered", text: "Ada's." },
		});
		const answered = await api(`/asks/${ask.id}`, { token: TOKENS.ada });
		expect(await answered.json()).toMatchObject({
			thread: [{ author: "human", by: { id: "owner", name: "owner" } }],
		});
		await client.close();
	});

	const good = "c".repeat(31) + "d";
	const other = "e".repeat(31) + "f";
	it.each([
		["an empty map", "{}", "LOOPBACK_TOKENS has no one in it"],
		["a list instead of a map", JSON.stringify([good]), "LOOPBACK_TOKENS must be a JSON object"],
		["something that isn't JSON", `owner=${good}`, "LOOPBACK_TOKENS must be a JSON object"],
		["a person with no name", JSON.stringify({ "": good }), "a person with no name"],
		["a token that isn't text", JSON.stringify({ ada: 12_345 }), '"ada"'],
		["a short token", JSON.stringify({ ada: "short-but-not-32-chars" }), '"ada"'],
		["one character repeated", JSON.stringify({ ada: "a".repeat(40) }), '"ada"'],
		["two people sharing a token", JSON.stringify({ ada: good, owner: good }), '"ada" and "owner"'],
	])("refuses a map it can't trust: %s", async (_case, tokens, names) => {
		const response = await api("/whoami", {
			token: good,
			settings: { LOOPBACK_TOKENS: tokens },
		});
		expect(response.status).toBe(500);
		const problem = (await response.json()) as { code: string; message: string };
		expect(problem.code).toBe("server.not_configured");
		expect(problem.message).toContain(names);
		expect(problem.message).not.toContain(good);
		expect(problem.message).not.toContain("short-but-not-32-chars");
		expect(problem.message).not.toContain("a".repeat(40));
	});

	it("says how to move from LOOPBACK_TOKEN", async () => {
		const response = await api("/whoami", {
			token: other,
			settings: { LOOPBACK_TOKENS: undefined, LOOPBACK_TOKEN: other },
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			code: "server.not_configured",
			message:
				'LOOPBACK_TOKEN is replaced by LOOPBACK_TOKENS: put your token in it as {"owner": "<token>"} and deploy again.',
		});
	});

	it("says how to set it when nothing is set", async () => {
		const response = await api("/whoami", { settings: { LOOPBACK_TOKENS: undefined } });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			code: "server.not_configured",
			message: expect.stringContaining("LOOPBACK_TOKENS is not set"),
		});
	});
});
