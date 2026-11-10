import {
	type Ask,
	BUILD_HEADER,
	RELOAD_CODE,
	REVISION_HEADER,
	type ServerEvent,
} from "@loopbacktools/protocol";
import * as Read from "@loopbacktools/protocol/schema";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { api, BASE, core, fetchEdge, json, OWNER, question, reply, TOKENS } from "./helpers.ts";

const spaceId = exports.Space.idFromName("default").toString();

describe("the API", () => {
	it("serves the snapshot an inbox starts from", async () => {
		const askId = await question("Snapshot me?");
		const response = await api("/snapshot");
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		const snapshot: { open: Ask[] } = await response.json();
		expect(snapshot.open.map((open) => open.id)).toContain(askId);
	});

	it("takes a reply, once", async () => {
		const askId = await question("Reply to me?");
		const replied = await reply(askId, { outcome: "answered", selected: ["Yes"] });
		expect(replied.status).toBe(200);
		expect(await replied.json()).toMatchObject({ id: askId, status: "closed" });
		const again = await reply(askId, { outcome: "dismissed" });
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "ask.closed" });
	});

	it("answers 422 for a reply that does not fit, 400 for one the contract refuses", async () => {
		const askId = await question("Fit me?");
		const misfit = await api(`/asks/${askId}/reply`, json({ outcome: "approved" }));
		expect(misfit.status).toBe(422);
		expect(await misfit.json()).toMatchObject({ code: "reply.invalid" });
		const malformed = await api(`/asks/${askId}/reply`, json({ outcome: "maybe" }));
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ code: "request.invalid" });
		const extra = await api(`/asks/${askId}/reply`, json({ outcome: "dismissed", why: "no" }));
		expect(extra.status).toBe(400);
	});

	it("answers 404 for an ask that does not exist, and for a route", async () => {
		expect((await api("/asks/nope")).status).toBe(404);
		expect((await reply("nope", { outcome: "dismissed" })).status).toBe(404);
		const route = await api("/nowhere");
		expect(route.status).toBe(404);
		expect(await route.json()).toMatchObject({ code: "not_found" });
	});

	it("pages back through closed asks", async () => {
		for (const text of ["One?", "Two?", "Three?"]) {
			await reply(await question(text), { outcome: "dismissed" });
		}
		const page: { items: Ask[]; nextBefore?: string } = await (await api("/asks?limit=2")).json();
		expect(page.items).toHaveLength(2);
		expect(page.nextBefore).toBeDefined();
		const next: { items: Ask[] } = await (
			await api(`/asks?limit=2&before=${encodeURIComponent(page.nextBefore ?? "")}`)
		).json();
		expect(next.items.map((item) => item.id)).not.toContain(page.items[0]?.id);
	});

	it("serves the OpenAPI document, naming the release it describes", async () => {
		const response = await api("/openapi.json", { token: null });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			openapi: "3.1.0",
			info: { version: packageJson.version },
			paths: { "/agent/questions": { put: { operationId: "ask_question" } } },
		});
	});
});

describe("the version", () => {
	const later = { [REVISION_HEADER]: String(Read.REVISION + 1) };

	it("is named on every answer, refusals included", async () => {
		const answers = [
			await api("/whoami"),
			await api("/whoami", { token: null }),
			await api("/nowhere"),
			await api("/whoami", { headers: later }),
		];
		expect(answers.map((answer) => answer.status)).toEqual([200, 401, 404, 409]);
		for (const answer of answers) {
			expect(answer.headers.get(REVISION_HEADER)).toBe(String(Read.REVISION));
			expect(answer.headers.get(BUILD_HEADER)).toBe(env.CF_VERSION_METADATA.timestamp);
		}
	});

	it("refuses a client writing a later revision, which reloads, before anything runs", async () => {
		const askId = await question("Reply from the future?");
		const refused = await api(`/asks/${askId}/reply`, {
			...json({ outcome: "dismissed" }),
			headers: { "Content-Type": "application/json", ...later },
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ code: RELOAD_CODE });
		expect((await core().Asks_read(OWNER, { id: askId })).body).toMatchObject({
			status: "awaiting_human",
		});
	});

	it("serves a client writing this revision or an earlier one", async () => {
		for (const revision of [Read.REVISION, Read.REVISION - 1]) {
			const answer = await api("/whoami", { headers: { [REVISION_HEADER]: String(revision) } });
			expect(answer.status).toBe(200);
		}
	});
});

describe("the event socket", () => {
	const upgrade = (protocols: string, headers: Record<string, string> = {}) =>
		fetchEdge(`${BASE}/events`, {
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols, ...headers },
		});
	const ticket = async () => {
		const response = await api("/events/tickets", { method: "POST" });
		expect(response.status).toBe(201);
		const issued: { ticket: string; expiresAt: string } = await response.json();
		return issued.ticket;
	};
	const firstFrames = (socket: WebSocket, count: number) => {
		const frames: ServerEvent[] = [];
		const arrived = new Promise<ServerEvent[]>((resolve) => {
			socket.addEventListener("message", (event) => {
				frames.push(JSON.parse(String(event.data)));
				if (frames.length === count) resolve(frames);
			});
		});
		socket.accept();
		return arrived;
	};

	it("opens once with a ticket, and streams the space", async () => {
		const pass = await ticket();
		const response = await upgrade(`loopback.v1, loopback.ticket.${pass}`);
		expect(response.status).toBe(101);
		expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("loopback.v1");
		const socket = response.webSocket;
		if (socket === null) throw new Error("no socket");
		const frames = firstFrames(socket, 2);
		const askId = await question("Stream me?");
		const [first, second] = await frames;
		expect(first?.type).toBe("snapshot");
		expect(second).toMatchObject({ type: "ask.opened", ask: { id: askId } });
		socket.close();
		expect((await upgrade(`loopback.v1, loopback.ticket.${pass}`)).status).toBe(401);
	});

	it("opens for a client that sends a token as a header, onto its own space", async () => {
		const response = await upgrade("loopback.v1", { Authorization: `Bearer ${TOKENS.ada}` });
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		if (socket === null) throw new Error("no socket");
		const [first] = await firstFrames(socket, 1);
		expect(first?.type).toBe("snapshot");
		socket.close();
	});

	it("refuses a token as a subprotocol, a missing one, and any ticket the core did not issue", async () => {
		expect((await upgrade("loopback.v1")).status).toBe(401);
		expect((await upgrade(`loopback.v1, loopback.token.${TOKENS.owner}`)).status).toBe(401);
		expect((await upgrade("loopback.v1, loopback.ticket.nonsense")).status).toBe(401);
		expect((await upgrade(`loopback.v1, loopback.ticket.${spaceId}.forged`)).status).toBe(401);
	});

	it("refuses a ticket once its minute is up", async () => {
		const pass = await ticket();
		await runInDurableObject(
			exports.Space.get(exports.Space.idFromName("default")),
			(_o, state) => {
				state.storage.sql.exec(
					"UPDATE event_tickets SET expires_at = ?",
					"2000-01-01T00:00:00.000Z",
				);
			},
		);
		expect((await upgrade(`loopback.v1, loopback.ticket.${pass}`)).status).toBe(401);
	});

	it("refuses a plain request", async () => {
		const response = await api("/events");
		expect(response.status).toBe(426);
		expect(await response.json()).toMatchObject({ code: "events.upgrade_required" });
	});
});

describe("uploads", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const put = (token: string, body: BodyInit, type = "image/png", id = spaceId) =>
		fetchEdge(`${BASE}/uploads/${id}/${token}`, {
			method: "PUT",
			body,
			headers: { "Content-Type": type },
		});
	const ticket = () => core().createUpload(OWNER, "image/png");

	it("stores an image once, without credentials, and serves it to the space", async () => {
		const issued = await ticket();
		const stored = await put(issued.token, png);
		expect(stored.status).toBe(201);
		expect(await stored.json()).toEqual({
			uploadId: issued.uploadId,
			contentType: "image/png",
			size: png.byteLength,
		});
		expect((await put(issued.token, png)).status).toBe(410);

		const file = await api(`/files/${issued.uploadId}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
		expect((await api(`/files/${issued.uploadId}`, { token: null })).status).toBe(401);
	});

	it("refuses an image sent without its length, leaving the ticket for one that has it", async () => {
		const issued = await ticket();
		const unsized = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(png);
				controller.close();
			},
		});
		const response = await put(issued.token, unsized);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ code: "upload.length_required" });
		expect((await put(issued.token, png)).status).toBe(201);
	});

	it("refuses the wrong type, an unknown ticket, and an unknown space", async () => {
		const issued = await ticket();
		const wrongType = await put(issued.token, png, "image/gif");
		expect(wrongType.status).toBe(422);
		expect(await wrongType.json()).toMatchObject({ code: "upload.rejected" });
		expect((await put("unknown", png)).status).toBe(404);
		expect((await put(issued.token, png, "image/png", "f".repeat(64))).status).toBe(404);
		expect((await put(issued.token, png, "image/png", "not-an-id")).status).toBe(404);
	});

	it("refuses an image over the limit, leaving the ticket for one that fits", async () => {
		const issued = await ticket();
		expect((await put(issued.token, new Uint8Array(issued.maxBytes + 1))).status).toBe(413);
		expect((await put(issued.token, png)).status).toBe(201);
	});

	it("answers 404 for a file that was never stored", async () => {
		const issued = await ticket();
		expect((await api(`/files/${issued.uploadId}`)).status).toBe(404);
	});
});

describe("an agent over HTTP", () => {
	it("waits for the reply to its question, and hears what it means", async () => {
		const asked = api(
			"/agent/questions",
			json(
				{
					question: "Over HTTP?",
					options: [{ label: "Yes" }, { label: "No" }],
					project: "edge-test",
				},
				"PUT",
			),
		);
		let askId: string | undefined;
		for (let attempt = 0; askId === undefined && attempt < 100; attempt += 1) {
			const snapshot = await core().Snapshots_read(OWNER, {});
			askId = snapshot.body.open.find(
				(open) => open.kind === "question" && open.prompt.question === "Over HTTP?",
			)?.id;
			if (askId === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (askId === undefined) throw new Error("The ask never opened.");
		await reply(askId, { outcome: "answered", selected: ["Yes"] });
		const response = await asked;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			askId,
			reply: { outcome: "answered", selected: ["Yes"] },
			message: 'The person answered. They chose: "Yes".',
		});
	});

	it("is refused with the contract's status and code", async () => {
		const response = await api(
			"/agent/follow-ups",
			json({ askId: "missing", answer: "Hello?" }, "PUT"),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ code: "not_found", message: 'No ask "missing".' });
	});

	it("finds the person's inbox", async () => {
		const response = await api("/agent/inbox?askId=ask-1");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: "https://loopback.test/w/default/asks/ask-1",
		});
	});
});

/** Every place a decoded message was read as `unknown`, by path: none, for what this edge sends. */
const unknownsIn = (value: unknown, path = "$"): string[] => {
	if (Array.isArray(value))
		return value.flatMap((item, index) => unknownsIn(item, `${path}[${index}]`));
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	const here = ["kind", "type", "outcome"].some((tag) => record[tag] === "unknown") ? [path] : [];
	return [
		...here,
		...Object.entries(record).flatMap(([key, inner]) => unknownsIn(inner, `${path}.${key}`)),
	];
};

describe("what the edge sends", () => {
	it("a reader decodes as what it is, at the contract's latest revision", async () => {
		const askId = await question("Read me?");
		await reply(askId, { outcome: "follow_up", question: "Which?" });
		const review = await core().requestReview(OWNER, {
			title: "Every block",
			summary: "Read in full.",
			content: [
				{ type: "markdown", text: "Prose." },
				{ type: "code", code: "const x = 1;", language: "ts", filename: "x.ts" },
				{ type: "diff", diff: "-a\n+b", filename: "a.txt" },
			],
			project: "edge-test",
		});
		expect(review.outcome).toBe("started");
		const briefing = await core().sendBriefing(OWNER, {
			title: "How it reads",
			sections: [{ title: "One", points: [{ title: "First" }, { title: "Second" }] }],
			project: "edge-test",
		});
		if (briefing.outcome !== "started") throw new Error(briefing.outcome);
		await reply(briefing.askId, { outcome: "responded", points: [{ point: "1", text: "Why?" }] });

		const snapshot = Schema.decodeUnknownSync(Read.Snapshot)(await (await api("/snapshot")).json());
		expect(new Set(snapshot.open.map((item) => item.kind))).toEqual(
			new Set(["question", "review", "briefing"]),
		);
		expect(unknownsIn(snapshot)).toEqual([]);
		const one = Schema.decodeUnknownSync(Read.Ask)(
			await (await api(`/asks/${briefing.askId}`)).json(),
		);
		expect(unknownsIn(one)).toEqual([]);
		expect(
			unknownsIn(Schema.decodeUnknownSync(Read.Whoami)(await (await api("/whoami")).json())),
		).toEqual([]);
	});
});
