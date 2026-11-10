import type { BriefingInput, QuestionInput, Reply, ReviewInput } from "@loopbacktools/protocol";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Caller, Wait } from "../src/rpc.ts";
import { core } from "./binding.ts";

/**
 * What an agent asks of the core, through the binding as an edge reaches it. The person's side
 * answers through the same binding, as the inbox's edge would.
 */

const callerIn = (space: string): Caller => ({ space, actor: { id: "owner" } });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A wait as a blocking edge passes it: long enough for any test, alive every 200 ms. */
const waiting = (budgetMs = 10_000): Wait => ({
	budgetMs,
	keepAliveMs: 200,
	progress: async () => {},
});

const colour: QuestionInput = {
	question: "Which colour should the button be?",
	options: [{ label: "Red" }, { label: "Blue" }],
	project: "loopback",
};

const tagline: ReviewInput = {
	title: "Tagline",
	content: [{ type: "markdown", text: "Ask anything." }],
	project: "loopback",
};

const storage: BriefingInput = {
	title: "Where things are kept",
	sections: [{ points: [{ title: "Sessions move to D1" }, { title: "R2 keeps images" }] }],
	project: "loopback",
};

/** The space's one open ask, once a call still in flight has opened it. */
const openedIn = async (caller: Caller): Promise<string> => {
	for (let tries = 0; tries < 50; tries++) {
		const snapshot = await core().Snapshots_read(caller, {});
		const id = snapshot.body.open[0]?.id;
		if (id !== undefined) return id;
		await pause(100);
	}
	throw new Error("No ask opened.");
};

/** Waits until the agent has made its move on an ask, so the person's reply comes after it. */
const theirTurn = async (caller: Caller, askId: string, entries: number) => {
	for (let tries = 0; tries < 50; tries++) {
		const read = await core().Asks_read(caller, { id: askId });
		if (read.status === 200 && read.body.thread.length === entries) return;
		await pause(100);
	}
	throw new Error(`Ask ${askId} never reached ${entries} entries.`);
};

/**
 * What a call failed with. An RPC promise is settled into a plain one before anything inspects it:
 * reading a property of an RPC promise pipelines another call, which fails too, unhandled.
 */
const failureOf = (call: Promise<unknown>): Promise<unknown> =>
	call.then(
		() => {
			throw new Error("The call succeeded.");
		},
		(error: unknown) => error,
	);

const reply = async (caller: Caller, askId: string, given: Reply) => {
	const replied = await core().Asks_reply(caller, { id: askId, reply: given });
	if (replied.status !== 200) throw new Error(JSON.stringify(replied));
};

describe("the agent's operations, through the binding", () => {
	it("brings a review's verdict, and says how to revise", async () => {
		const caller = callerIn(crypto.randomUUID());
		const review = core().requestReview(caller, tagline, undefined, waiting());
		const askId = await openedIn(caller);
		await reply(caller, askId, { outcome: "changes_requested", feedback: "Warmer, please." });
		expect(await review).toEqual({
			outcome: "replied",
			askId,
			kind: "review",
			reply: { outcome: "changes_requested", feedback: "Warmer, please." },
			message: `Changes requested: Warmer, please.\n\nRevise the work, then call request_review again with revises: "${askId}".`,
		});
	});

	it("carries a follow-up through to the decision", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().requestReview(caller, tagline);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		const { askId } = opened;
		await reply(caller, askId, { outcome: "follow_up", question: "Why?" });
		expect(await core().followTask(caller, opened.taskId)).toMatchObject({
			status: "completed",
			askId,
			reply: { outcome: "follow_up", question: "Why?" },
			message: `The person asked a question before deciding: Why?\n\nAnswer it with answer_follow_up (askId: "${askId}"). This ask stays open, and that call returns their decision.`,
		});
		const answering = core().answerFollowUp(caller, { askId, answer: "Because." }, waiting());
		await theirTurn(caller, askId, 2);
		await reply(caller, askId, { outcome: "approved", note: "Fine" });
		expect(await answering).toEqual({
			outcome: "replied",
			askId,
			kind: "review",
			reply: { outcome: "approved", note: "Fine" },
			message: "Approved, with a note: Fine",
		});
	});

	it("names the ask's kind, and the client that opened it, with every outcome", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour, "claude-code 2.1.0");
		expect(opened).toMatchObject({
			outcome: "started",
			kind: "question",
			client: "claude-code 2.1.0",
		});
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		await reply(caller, opened.askId, { outcome: "follow_up", question: "Why?" });
		const answering = core().answerFollowUp(
			caller,
			{ askId: opened.askId, answer: "Because." },
			waiting(),
		);
		await theirTurn(caller, opened.askId, 2);
		await reply(caller, opened.askId, { outcome: "answered", selected: ["Red"] });
		expect(await answering).toMatchObject({
			outcome: "replied",
			kind: "question",
			client: "claude-code 2.1.0",
		});
		const briefing = await core().sendBriefing(caller, storage, undefined, waiting(300));
		expect(briefing).toMatchObject({ outcome: "waiting", kind: "briefing" });
		expect(briefing).not.toHaveProperty("client");
	});

	it("starts an answer to a follow-up as a task on the agent's turn", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().requestReview(caller, tagline);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		await reply(caller, opened.askId, { outcome: "follow_up", question: "Why?" });
		const answered = await core().answerFollowUp(caller, {
			askId: opened.askId,
			answer: "Because.",
		});
		expect(answered).toMatchObject({
			outcome: "started",
			askId: opened.askId,
			taskId: `${opened.askId}:2`,
			turn: 2,
		});
	});

	it("carries a briefing point by point, naming each point by its title", async () => {
		const caller = callerIn(crypto.randomUUID());
		const briefing = core().sendBriefing(caller, storage, undefined, waiting());
		const askId = await openedIn(caller);
		await reply(caller, askId, {
			outcome: "responded",
			points: [{ point: "2", text: "Which bucket?" }],
		});
		expect(await briefing).toMatchObject({
			outcome: "replied",
			askId,
			message: `The person replied on the briefing:\n- Point 2 (R2 keeps images): they wrote "Which bucket?"\n\nAnswer point 2 (R2 keeps images) with answer_briefing (askId: "${askId}"): each is owed an answer. You may answer other open points too, and break any point into sub-points.`,
		});

		const answering = core().answerBriefing(
			caller,
			{ askId, answers: [{ point: "2", answer: "The images bucket." }] },
			waiting(),
		);
		await theirTurn(caller, askId, 2);
		await reply(caller, askId, {
			outcome: "responded",
			points: [
				{ point: "1", resolved: true },
				{ point: "2", resolved: true },
			],
		});
		expect(await answering).toMatchObject({
			outcome: "replied",
			askId,
			message:
				"The person replied on the briefing:\n- Point 1 (Sessions move to D1): resolved.\n- Point 2 (R2 keeps images): resolved.\n\nThe briefing is closed: every point is resolved. Act on what they said, or ask a new question if something is still unclear.",
		});
	});

	it("starts an answer to a briefing as a task on the agent's turn", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().sendBriefing(caller, storage);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		await reply(caller, opened.askId, {
			outcome: "responded",
			points: [{ point: "1", text: "Why?" }],
		});
		const answered = await core().answerBriefing(caller, {
			askId: opened.askId,
			answers: [{ point: "1", answer: "Queries." }],
		});
		expect(answered).toMatchObject({
			outcome: "started",
			askId: opened.askId,
			taskId: `${opened.askId}:2`,
			turn: 2,
		});
	});

	it("refuses what the space won't take, with the contract's status and code, in the words agents already know", async () => {
		const caller = callerIn(crypto.randomUUID());
		expect(await core().answerFollowUp(caller, { askId: "missing", answer: "Hello?" })).toEqual({
			outcome: "refused",
			status: 404,
			code: "not_found",
			message: 'No ask "missing".',
		});
		expect(
			await core().answerBriefing(caller, {
				askId: "missing",
				answers: [{ point: "1", answer: "Hello?" }],
			}),
		).toEqual({
			outcome: "refused",
			status: 404,
			code: "not_found",
			message: 'No briefing "missing".',
		});

		const question = await core().askQuestion(caller, colour);
		if (question.outcome !== "started") throw new Error(question.outcome);
		expect(
			await core().answerFollowUp(caller, { askId: question.askId, answer: "Hello?" }),
		).toEqual({
			outcome: "refused",
			status: 409,
			code: "ask.human_turn",
			message: "The person has not asked anything back on that ask, so there is nothing to answer.",
		});
		await reply(caller, question.askId, { outcome: "answered", selected: ["Red"] });
		expect(
			await core().answerFollowUp(caller, { askId: question.askId, answer: "Hello?" }),
		).toEqual({
			outcome: "refused",
			status: 409,
			code: "ask.closed",
			message: "That ask is closed; the person has already decided.",
		});

		const briefing = await core().sendBriefing(caller, storage);
		if (briefing.outcome !== "started") throw new Error(briefing.outcome);
		const early = { askId: briefing.askId, answers: [{ point: "1", answer: "Hello?" }] };
		expect(await core().answerBriefing(caller, early)).toEqual({
			outcome: "refused",
			status: 409,
			code: "ask.human_turn",
			message:
				"The person has not replied on that briefing since your last answers, so there is nothing to answer yet.",
		});
		await reply(caller, briefing.askId, { outcome: "dismissed" });
		expect(await core().answerBriefing(caller, early)).toEqual({
			outcome: "refused",
			status: 409,
			code: "ask.closed",
			message:
				"The person closed that briefing. Act on what they said, or ask a new question if something is still unclear.",
		});

		expect(
			await core().requestReview(caller, {
				title: "A picture",
				content: [{ type: "image", uploadId: "nope" }],
				project: "loopback",
			}),
		).toEqual({
			outcome: "refused",
			status: 422,
			code: "content.invalid",
			message: 'No uploaded image "nope". Upload it with create_image_upload first.',
		});
	});

	it("follows a task to its reply, polled as often as the edge says", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		expect(await core().followTask(caller, opened.taskId)).toEqual({
			taskId: opened.taskId,
			status: "working",
			createdAt: opened.at,
			lastUpdatedAt: opened.at,
			pollIntervalMs: 2_000,
			message: "Waiting for the person to reply in Loopback.",
		});
		expect(await core().followTask(caller, opened.taskId, [3_000, 12_000, 40_000])).toMatchObject({
			status: "working",
			pollIntervalMs: 3_000,
		});

		await reply(caller, opened.askId, { outcome: "answered", selected: ["Red"] });
		expect(await core().followTask(caller, opened.taskId)).toMatchObject({
			taskId: opened.taskId,
			status: "completed",
			askId: opened.askId,
			reply: { outcome: "answered", selected: ["Red"] },
			message: 'The person answered. They chose: "Red".',
		});
	});

	it("cancels a task, leaving its ask open for the person", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		await core().followTask(caller, opened.taskId);
		expect(await core().cancelTask(caller, opened.taskId)).toMatchObject({
			taskId: opened.taskId,
			status: "cancelled",
		});
		expect(await core().followTask(caller, opened.taskId)).toMatchObject({
			status: "cancelled",
		});
		const ask = await core().Asks_read(caller, { id: opened.askId });
		expect(ask).toMatchObject({ status: 200, body: { status: "awaiting_human", waiting: false } });
	});

	it("knows no task its space does not hold", async () => {
		const caller = callerIn(crypto.randomUUID());
		const opened = await core().askQuestion(caller, colour);
		if (opened.outcome !== "started") throw new Error(opened.outcome);
		for (const taskId of [
			"not-a-task",
			`${crypto.randomUUID()}:0`,
			`${opened.askId}:7`,
			`${opened.askId}:-1`,
		]) {
			expect(await core().followTask(caller, taskId)).toBeNull();
			expect(await core().cancelTask(caller, taskId)).toBeNull();
		}
	});

	it("stops waiting once its caller has gone, keeping the reply for the retry", async () => {
		const caller = callerIn(crypto.randomUUID());
		const began = Date.now();
		const gone = await core().askQuestion(caller, colour, undefined, {
			budgetMs: 30_000,
			keepAliveMs: 200,
			progress: async () => {
				throw new Error("The agent's client went away.");
			},
		});
		expect(Date.now() - began).toBeLessThan(10_000);
		if (gone.outcome !== "waiting") throw new Error(gone.outcome);
		// The inbox stops showing an agent waiting.
		let stillWaiting = true;
		for (let tries = 0; stillWaiting && tries < 50; tries++) {
			const ask = await core().Asks_read(caller, { id: gone.askId });
			stillWaiting = ask.status === 200 && ask.body.waiting;
			if (stillWaiting) await pause(50);
		}
		expect(stillWaiting).toBe(false);

		await reply(caller, gone.askId, { outcome: "answered", selected: [], text: "Yes" });
		expect(await core().askQuestion(caller, colour, undefined, waiting())).toMatchObject({
			outcome: "replied",
			askId: gone.askId,
			reply: { outcome: "answered", selected: [], text: "Yes" },
		});
	});

	it("carries a wait through a restart of its space", async () => {
		const caller = callerIn(crypto.randomUUID());
		const call = core().askQuestion(caller, colour, undefined, waiting());
		const askId = await openedIn(caller);
		await pause(300);
		// In-memory state gone and every socket dropped: the wait reconnects and carries on.
		await abortAllDurableObjects();
		await pause(300);
		await reply(caller, askId, { outcome: "answered", selected: [], text: "Made it" });
		expect(await call).toMatchObject({
			outcome: "replied",
			askId,
			reply: { outcome: "answered", selected: [], text: "Made it" },
		});
	});

	it("carries a wait through its space moving onto new code", async () => {
		const caller = callerIn(crypto.randomUUID());
		const call = core().askQuestion(caller, colour, undefined, waiting());
		const askId = await openedIn(caller);
		await pause(300);
		await runInDurableObject(exports.Space.getByName(caller.space), (_object, state) => {
			for (const socket of state.getWebSockets(`wait:${askId}`)) {
				socket.close(1012, "Loopback was updated.");
			}
		});
		await pause(300);
		await reply(caller, askId, { outcome: "answered", selected: [], text: "Still here" });
		expect(await call).toMatchObject({
			outcome: "replied",
			askId,
			reply: { outcome: "answered", selected: [], text: "Still here" },
		});
	});

	it("fails a wait whose ask is erased under it", async () => {
		const caller = callerIn(crypto.randomUUID());
		// Handled from the start: the call fails while the test is still erasing.
		const asking = failureOf(core().askQuestion(caller, colour, undefined, waiting()));
		await openedIn(caller);
		await pause(300);
		await core().erase(caller.space);
		expect(await asking).toBeInstanceOf(Error);
	});

	it("runs nothing it can't read from an edge newer than itself, and keeps nothing", async () => {
		const caller = callerIn(crypto.randomUUID());
		const fromTheFuture = {
			title: "A hologram",
			content: [{ type: "hologram", text: "?" }],
			project: "loopback",
		} as unknown as ReviewInput;
		const failure = await failureOf(core().requestReview(caller, fromTheFuture));
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/newer revision of the contract/);
		expect(await core().Snapshots_read(caller, {})).toEqual({
			status: 200,
			body: { open: [], recent: [] },
		});
	});
});
