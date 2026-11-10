import type { UploadTicket } from "@loopbacktools/protocol";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
	connect,
	core,
	type Era,
	fetchEdge,
	opened,
	ORIGIN,
	OWNER,
	reply,
	textOf,
	TOKENS,
} from "./helpers.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each<Era>(["legacy", "auto"])("the MCP endpoint (%s negotiation)", (mode) => {
	const connectHere = (options: Parameters<typeof connect>[0] = {}) =>
		connect({ mode, ...options });

	it("refuses a client without a token in the map", async () => {
		const response = await fetchEdge(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
		expect(response.status).toBe(401);
		await expect(connectHere({ token: "f".repeat(64) })).rejects.toThrow();
	});

	it("offers the contract's tools and says when to use them", async () => {
		const client = await connectHere();
		expect(client.getServerVersion()).toMatchObject({
			name: "loopback",
			version: packageJson.version,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).toSorted()).toEqual([
			"answer_briefing",
			"answer_follow_up",
			"ask_question",
			"create_image_upload",
			"open_inbox",
			"request_review",
			"send_briefing",
		]);
		expect(client.getInstructions()).toContain("ask_question");
		expect(client.getInstructions()).toContain("send_briefing");
		// No background tasks until the emitter can declare them: every call waits.
		expect(client.getServerCapabilities()?.extensions).toBeUndefined();
		await client.close();
	});

	it("blocks ask_question until the person answers, reporting progress meanwhile", async () => {
		const client = await connectHere({ edge: { budgets: { keepAliveMs: 200 } } });
		const progress: number[] = [];
		const question = `Which database (${mode})?`;
		const call = client.callTool(
			{
				name: "ask_question",
				arguments: {
					question,
					options: [{ label: "D1" }, { label: "Durable Object SQLite" }],
					project: "edge-test",
				},
			},
			{ onprogress: (update) => progress.push(update.progress) },
		);
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === question,
		);
		expect(ask.project).toBe("edge-test");
		// Only the 2026-07-28 envelope names the client on every request.
		expect(ask.client).toBe(mode === "auto" ? "loopback-test 1.0.0" : undefined);
		await pause(500);
		await reply(ask.id, { outcome: "answered", selected: ["D1"], text: "Keep it simple" });
		const result = await call;
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "answered", selected: ["D1"], text: "Keep it simple" },
			message: 'The person answered. They chose: "D1". They wrote: Keep it simple',
		});
		expect(textOf(result)).toContain('They chose: \\"D1\\".');
		expect(progress.length).toBeGreaterThan(1);
		await client.close();
	});

	it("runs a review through a follow-up to approval", async () => {
		const client = await connectHere();
		const title = `Release notes (${mode})`;
		const review = client.callTool({
			name: "request_review",
			arguments: {
				title,
				content: [{ type: "markdown", text: "Loopback 0.1 is out." }],
				project: "edge-test",
			},
		});
		const ask = await opened((open) => open.kind === "review" && open.prompt.title === title);
		await reply(ask.id, { outcome: "follow_up", question: "Is 0.1 the right number?" });
		const followUp = await review;
		expect(followUp.structuredContent).toMatchObject({ reply: { outcome: "follow_up" } });
		expect(textOf(followUp)).toContain("answer_follow_up");

		const answer = client.callTool({
			name: "answer_follow_up",
			arguments: { askId: ask.id, answer: "Yes: it is the first release." },
		});
		await opened((open) => open.id === ask.id && open.status === "awaiting_human");
		await reply(ask.id, { outcome: "approved", note: "Ship it" });
		expect((await answer).structuredContent).toEqual({
			askId: ask.id,
			reply: { outcome: "approved", note: "Ship it" },
			message: "Approved, with a note: Ship it",
		});
		await client.close();
	});

	it("gives the address of the inbox, or of one ask in it", async () => {
		const client = await connectHere();
		const inbox = await client.callTool({ name: "open_inbox", arguments: {} });
		expect(inbox.structuredContent).toEqual({ url: `${ORIGIN}/w/default` });
		const one = await client.callTool({ name: "open_inbox", arguments: { askId: "a b" } });
		expect(one.structuredContent).toEqual({ url: `${ORIGIN}/w/default/asks/a%20b` });
		await client.close();
	});

	it("refuses an ask that does not name its project", async () => {
		const client = await connectHere();
		const result = await client.callTool({
			name: "ask_question",
			arguments: { question: "Who am I?" },
		});
		expect(result.isError).toBe(true);
		await client.close();
	});

	it("refuses answer_follow_up for an ask it doesn't know, in the contract's words", async () => {
		const client = await connectHere();
		const result = await client.callTool({
			name: "answer_follow_up",
			arguments: { askId: "missing", answer: "Hello?" },
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(textOf(result))).toEqual({
			code: "not_found",
			message: 'No ask "missing".',
		});
		await client.close();
	});

	it("uploads an image and shows it in a review", async () => {
		const client = await connectHere();
		const issued = await client.callTool({
			name: "create_image_upload",
			arguments: { contentType: "image/png" },
		});
		const ticket = issued.structuredContent as UploadTicket;
		expect(ticket.uploadUrl.startsWith(`${ORIGIN}/api/v1/uploads/`)).toBe(true);
		expect(ticket.command).toBe(
			`curl -sS --fail-with-body -X PUT -H 'Content-Type: image/png' --data-binary @FILE '${ticket.uploadUrl}'`,
		);
		const stored = await fetchEdge(ticket.uploadUrl, {
			method: "PUT",
			body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			headers: { "Content-Type": "image/png" },
		});
		expect(stored.status).toBe(201);

		const missing = await client.callTool({
			name: "request_review",
			arguments: {
				title: "Missing",
				content: [{ type: "image", uploadId: "nope" }],
				project: "edge-test",
			},
		});
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("create_image_upload");

		const title = `Screenshot (${mode})`;
		const review = client.callTool({
			name: "request_review",
			arguments: {
				title,
				content: [{ type: "image", uploadId: ticket.uploadId }],
				project: "edge-test",
			},
		});
		const ask = await opened((open) => open.kind === "review" && open.prompt.title === title);
		await reply(ask.id, { outcome: "dismissed" });
		expect((await review).structuredContent).toMatchObject({ reply: { outcome: "dismissed" } });
		await client.close();
	});

	it("leaves the ask open when the agent stops waiting, and stops showing it waiting within a lap", async () => {
		const client = await connectHere({ edge: { budgets: { keepAliveMs: 1_000 } } });
		const stop = new AbortController();
		const question = `Abandon me (${mode})?`;
		const call = client.callTool(
			{ name: "ask_question", arguments: { question, project: "edge-test" } },
			{ signal: stop.signal },
		);
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === question,
		);
		stop.abort();
		await expect(call).rejects.toThrow();
		await client.close();
		let waiting = true;
		for (let tries = 0; waiting && tries < 60; tries += 1) {
			const read = await core().Asks_read(OWNER, { id: ask.id });
			if (read.status !== 200) throw new Error(`The ask is ${read.status}.`);
			expect(read.body.status).toBe("awaiting_human");
			waiting = read.body.waiting;
			if (waiting) await pause(100);
		}
		expect(waiting).toBe(false);
	});

	it("ends a wait at its budget with a result that says to call again, and the call rejoins", async () => {
		const client = await connectHere({ edge: { budgets: { waitMs: 500 } } });
		const input = { question: `Within budget (${mode})?`, project: "edge-test" };
		const first = await client.callTool({ name: "ask_question", arguments: input });
		expect(first.isError ?? false).toBe(false);
		const askId = (first.structuredContent as { askId: string }).askId;
		expect(first.structuredContent).toEqual({
			askId,
			reply: null,
			message:
				"No reply yet. Call ask_question again with the same arguments to keep waiting; it rejoins this ask.",
		});
		await reply(askId, { outcome: "answered", selected: [], text: "Yes" });
		const again = await client.callTool({ name: "ask_question", arguments: input });
		expect(again.structuredContent).toMatchObject({
			askId,
			reply: { outcome: "answered", selected: [], text: "Yes" },
		});
		await client.close();
	});

	it("tells the agent an incident to quote, not Loopback's internals, when a tool breaks", async () => {
		const client = await connectHere({
			settings: {
				CORE: {
					revision: async () => Number.MAX_SAFE_INTEGER,
					askQuestion: async () => {
						throw new Error("SQLITE_FULL: secret internals");
					},
				},
			},
		});
		const result = await client.callTool({
			name: "ask_question",
			arguments: { question: "Break?", project: "edge-test" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^Something went wrong in Loopback\. Incident \S+\.$/);
		expect(textOf(result)).not.toContain("SQLITE_FULL");
		await client.close();
	});
});

describe("a blocking call on Workers Free", () => {
	it("keeps alive past a client's 60 s timeout with progress, and returns the reply", async () => {
		const client = await connect({ token: TOKENS.ada });
		const call = client.callTool(
			{ name: "ask_question", arguments: { question: "Past a minute?", project: "edge-test" } },
			{ timeout: 60_000, resetTimeoutOnProgress: true, onprogress: () => {} },
		);
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === "Past a minute?",
		);
		await pause(65_000);
		await reply(ask.id, { outcome: "answered", selected: [], text: "Still here." });
		const result = await call;
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			askId: ask.id,
			reply: { outcome: "answered", text: "Still here." },
		});
		await client.close();
	}, 120_000);
});

describe("listen streams", () => {
	it("acknowledges a listen and closes it, since Loopback publishes no list changes", async () => {
		const response = await fetchEdge(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKENS.owner}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "subscriptions/listen",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "subscriptions/listen",
				params: {
					notifications: { toolsListChanged: true },
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": { name: "listen-test", version: "1.0.0" },
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
		// A stream left open never ends: read it for two seconds at most.
		const body = await Promise.race([response.text(), pause(2_000).then(() => "still open")]);
		expect(body).not.toBe("still open");
		const frames = body
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: {} },
		});
		expect(frames[1]).toMatchObject({ id: 1, result: {} });
	});
});
