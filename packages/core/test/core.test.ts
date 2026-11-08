import type { QuestionInput } from "@loopbacktools/protocol";
import { REVISION } from "@loopbacktools/protocol/schema";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Caller } from "../src/rpc.ts";

/**
 * The core as an edge reaches it: every call goes through `env.CORE`, a service binding to this
 * Worker's own `Core` entrypoint, so arguments and answers cross a real binding.
 */
const core = () => env.CORE;

const callerIn = (space: string): Caller => ({ space, actor: { id: "owner" } });

const colour: QuestionInput = {
	question: "Which colour should the button be?",
	options: [{ label: "Red" }, { label: "Blue" }],
	project: "loopback",
};

const bytes = (...values: number[]) =>
	new ReadableStream<Uint8Array>({
		type: "bytes",
		start(controller) {
			controller.enqueue(new Uint8Array(values));
			controller.close();
		},
	});

const read = async (body: ReadableStream<Uint8Array>) =>
	[...new Uint8Array(await new Response(body).arrayBuffer())];

const firstFrame = (socket: WebSocket) =>
	new Promise<unknown>((resolve) => {
		socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
			once: true,
		});
		socket.accept();
	});

describe("the core, through its binding", () => {
	it("says who is calling", async () => {
		const caller = callerIn(crypto.randomUUID());
		expect(await core().Session_whoami(caller, {})).toEqual({
			status: 200,
			body: { space: caller.space, actor: { id: "owner" } },
		});
	});

	it("opens a question and, asked not to wait, starts it as a task", async () => {
		const opened = await core().askQuestion(callerIn(crypto.randomUUID()), colour);
		expect(opened.outcome).toBe("started");
		if (opened.outcome !== "started") return;
		expect(opened.taskId).toBe(`${opened.askId}:0`);
	});

	it("reads an open ask, and answers 404 for one it does not hold", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		const snapshot = await core().Snapshots_read(caller, {});
		expect(snapshot.status).toBe(200);
		expect(JSON.stringify(snapshot.body)).toContain(opened.askId);
		expect((await core().Asks_read(caller, { id: opened.askId })).status).toBe(200);
		const missing = await core().Asks_read(caller, { id: "no-such-ask" });
		expect(missing).toMatchObject({ status: 404, body: { code: "not_found" } });
	});

	it("takes a reply, and refuses a second one", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		const reply = { outcome: "answered", selected: ["Red"] } as const;
		expect((await core().Asks_reply(caller, { id: opened.askId, reply })).status).toBe(200);
		expect(await core().Asks_reply(caller, { id: opened.askId, reply })).toMatchObject({
			status: 409,
			body: { code: "ask.closed" },
		});
	});

	it("waits for the reply, saying it is still there while it waits", async () => {
		const caller = callerIn(crypto.randomUUID());
		const steps: number[] = [];
		const waiting = core().askQuestion(caller, colour, undefined, {
			budgetMs: 10_000,
			keepAliveMs: 200,
			progress: async (step) => {
				steps.push(step);
			},
		});
		// The person replies once the agent is waiting.
		let askId: string | undefined;
		for (let tries = 0; askId === undefined && tries < 50; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const snapshot = await core().Snapshots_read(caller, {});
			if (snapshot.status === 200) askId = snapshot.body.open[0]?.id;
		}
		if (askId === undefined) throw new Error("The question never opened.");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await core().Asks_reply(caller, { id: askId, reply: { outcome: "answered", selected: ["Red"] } });
		const outcome = await waiting;
		expect(outcome).toMatchObject({ outcome: "replied", askId });
		if (outcome.outcome !== "replied") return;
		expect(outcome.message).toContain('They chose: "Red".');
		expect(steps.length).toBeGreaterThanOrEqual(1);
	});

	it("says there is no reply yet when the wait's budget runs out", async () => {
		const outcome = await core().askQuestion(callerIn(crypto.randomUUID()), colour, undefined, {
			budgetMs: 600,
			keepAliveMs: 200,
			progress: async () => {},
		});
		expect(outcome).toMatchObject({ outcome: "waiting" });
		if (outcome.outcome !== "waiting") return;
		expect(outcome.message).toBe(
			"No reply yet. Call ask_question again with the same arguments to keep waiting; it rejoins this ask.",
		);
	});

	it("issues an upload, stores its bytes, and reads them back", async () => {
		const caller = callerIn(crypto.randomUUID());
		const issued = await core().createUpload(caller, "image/png");
		if (issued.outcome !== "issued") throw new Error(issued.outcome);
		const stored = await core().Uploads_store(caller, {
			spaceId: issued.spaceId,
			token: issued.token,
			"Content-Type": "image/png",
			length: 3,
			body: bytes(1, 2, 3),
		});
		expect(stored).toMatchObject({ status: 201, body: { uploadId: issued.uploadId, size: 3 } });
		const file = await core().Files_read(caller, { uploadId: issued.uploadId });
		expect(file.status).toBe(200);
		if (file.status !== 200) return;
		expect(file.contentType).toBe("image/png");
		expect(await read(file.body as ReadableStream<Uint8Array>)).toEqual([1, 2, 3]);
	});

	it("refuses a body that runs past or stops short of its length", async () => {
		const caller = callerIn(crypto.randomUUID());
		for (const body of [bytes(1, 2, 3, 4), bytes(1, 2)]) {
			const issued = await core().createUpload(caller, "image/png");
			if (issued.outcome !== "issued") throw new Error(issued.outcome);
			const stored = await core().Uploads_store(caller, {
				spaceId: issued.spaceId,
				token: issued.token,
				"Content-Type": "image/png",
				length: 3,
				body,
			});
			expect(stored).toMatchObject({ status: 422, body: { code: "upload.incomplete" } });
			expect((await core().Files_read(caller, { uploadId: issued.uploadId })).status).toBe(404);
		}
	});

	it("answers 404 for an upload to a space it did not mint", async () => {
		const stored = await core().Uploads_store(callerIn("anyone"), {
			spaceId: "f".repeat(64),
			token: "nope",
			"Content-Type": "image/png",
			length: 3,
			body: bytes(1, 2, 3),
		});
		expect(stored.status).toBe(404);
	});

	it("accepts an inbox's socket by ticket, sending the space first", async () => {
		const caller = callerIn(crypto.randomUUID());
		const issued = await core().EventTickets_issue(caller, {});
		if (issued.status !== 201) throw new Error(String(issued.status));
		const [spaceId, secret] = issued.body.ticket.split(".");
		const upgrade = await core().fetch(
			new Request(`http://core/spaces/id/${spaceId}/events?ticket=${secret}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		expect(upgrade.status).toBe(101);
		const socket = upgrade.webSocket;
		if (socket === null) throw new Error("No socket.");
		expect(await firstFrame(socket)).toMatchObject({ type: "snapshot" });
		socket.close();
		const spent = await core().fetch(
			new Request(`http://core/spaces/id/${spaceId}/events?ticket=${secret}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		expect(spent.status).toBe(401);
		const plain = await core().fetch(new Request(`http://core/spaces/id/${spaceId}/events`));
		expect(plain.status).toBe(426);
	});

	it("erases a space and its files", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		const issued = await core().createUpload(caller, "image/png");
		if (opened.outcome !== "started" || issued.outcome !== "issued") throw new Error("setup");
		await core().Uploads_store(caller, {
			spaceId: issued.spaceId,
			token: issued.token,
			"Content-Type": "image/png",
			length: 3,
			body: bytes(1, 2, 3),
		});
		await core().erase(caller.space);
		expect(await core().Snapshots_read(caller, {})).toEqual({
			status: 200,
			body: { open: [], recent: [] },
		});
		expect((await core().Files_read(caller, { uploadId: issued.uploadId })).status).toBe(404);
	});

	it("says which revision of the contract it speaks", async () => {
		expect(await core().revision()).toBe(REVISION);
	});
});
