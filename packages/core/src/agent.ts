import type {
	Ask,
	BriefingAnswerInput,
	BriefingAsk,
	BriefingInput,
	FollowUpInput,
	ImageType,
	QuestionInput,
	ReviewInput,
	ToolReply,
} from "@loopbacktools/protocol";
import { Data, Effect, Option } from "effect";
import type { AskNotFound, ContentInvalid } from "./domain/errors.ts";
import { POLL_INTERVALS, type PollIntervals, pollEvery } from "./domain/polling.ts";
import type { AskOutcome, Caller, IssuedUpload, Replied, TaskView, Wait } from "./rpc.ts";
import type { Delivery, TaskState } from "./space/operations.ts";
import type { SpaceClient } from "./space/rpc.ts";
import { Spaces } from "./spaces.ts";
import { describe, noReplyYet, type Tool, WAITING_FOR_THE_PERSON } from "./words.ts";

/**
 * A task follows the reply to one of the agent's turns on an ask: `<askId>:<turn>`, where the turn
 * is the thread entry the agent's move ended with, 0 for opening the ask. Ask ids are random, and
 * a task is only ever looked for in its caller's space.
 */
const taskIdOf = (askId: string, turn: number) => `${askId}:${turn}`;

const taskOf = (
	taskId: string,
): Option.Option<{ readonly askId: string; readonly turn: number }> => {
	const split = taskId.lastIndexOf(":");
	const turn = Number(taskId.slice(split + 1));
	if (split <= 0 || !Number.isSafeInteger(turn) || turn < 0) return Option.none();
	return Option.some({ askId: taskId.slice(0, split), turn });
};

const refused = (message: string): AskOutcome => ({ outcome: "refused", message });

const notYet = (tool: Tool, askId: string): AskOutcome => ({
	outcome: "waiting",
	askId,
	message: noReplyYet(tool),
});

/** A reply as the agent receives it: the contract's reply, and what it means in words. */
const replied = (delivery: Delivery, briefing?: BriefingAsk): Replied => {
	const reply: ToolReply = { askId: delivery.askId, reply: delivery.reply };
	return {
		askId: reply.askId,
		reply: reply.reply,
		message: describe(reply, briefing === undefined ? undefined : { briefing, seq: delivery.seq }),
	};
};

/** The briefing a reply was given on, read only when the reply is one, to name its points. */
const briefingFor = (
	space: SpaceClient,
	reply: ToolReply | null,
): Effect.Effect<BriefingAsk | undefined, AskNotFound> =>
	reply?.reply.outcome === "responded"
		? Effect.map(space.get(reply.askId), (ask: Ask) => (ask.kind === "briefing" ? ask : undefined))
		: Effect.succeed(undefined);

/**
 * The turn an opened ask is followed from: its opening for a new ask, and the agent's latest move
 * for one a retried call rejoined, so its task completes with the reply still to come, not the first.
 */
const latestTurn = (ask: Ask): readonly [turn: number, at: string] => {
	const last = ask.thread.findLastIndex((entry) => entry.author === "agent");
	const entry = ask.thread[last];
	return entry === undefined ? [0, ask.createdAt] : [last + 1, entry.at];
};

/** The caller's progress callback rejected: its client has gone, and no one is waiting any more. */
class CallerLeft extends Data.TaggedError("CallerLeft")<{ readonly cause: unknown }> {}

/** How many times a wait reconnects in a row, its socket dropping each time, before it gives up. */
const RECONNECTS = 8;

/**
 * Waits until the person replies to the ask, and takes the reply. The wait is a socket to the space,
 * which can sleep meanwhile: it wakes the socket when a reply lands. Every lap the wait pings the
 * socket and tells the caller it is alive. A socket dropped under the wait, by a restart or by the
 * space moving onto new code, is opened again, after a backoff that grows while it keeps dropping.
 * A caller that has gone stops the wait before it takes the reply, which leaves it for the retry.
 * A call that has waited its budget answers that there is no reply yet, and the agent's next call
 * rejoins the ask. The ask was just opened or answered, so one that has vanished is a broken
 * invariant, not an error to report.
 */
const replyTo = (
	caller: Caller,
	space: SpaceClient,
	askId: string,
	turn: number,
	tool: Tool,
	wait: Wait,
): Effect.Effect<AskOutcome, never, Spaces> =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		const until = Date.now() + wait.budgetMs;
		let step = 0;
		let drops = 0;
		for (;;) {
			const taken = yield* Effect.scoped(
				Effect.gen(function* () {
					const waiter = yield* spaces.wait(caller.space, askId, turn);
					for (;;) {
						const left = until - Date.now();
						if (left <= 0) return notYet(tool, askId);
						const lap = step;
						yield* Effect.tryPromise({
							try: () => wait.progress(lap),
							catch: (cause) => new CallerLeft({ cause }),
						});
						step += 1;
						const said = yield* Effect.timeoutOption(waiter.next, Math.min(wait.keepAliveMs, left));
						if (Option.isNone(said)) {
							// A lap with the socket alive: the drops before it are behind us.
							drops = 0;
							yield* waiter.ping;
							continue;
						}
						if (said.value === "closed") return null;
						const delivery = yield* space.takeReply(askId, turn);
						if (delivery !== null) {
							yield* space.markDelivered(askId, delivery.seq);
							const outcome: AskOutcome = {
								outcome: "replied",
								...replied(delivery, yield* briefingFor(space, delivery)),
							};
							return outcome;
						}
					}
				}),
			).pipe(Effect.catchTag("SpaceUnavailable", () => Effect.succeed(null)));
			if (taken !== null) return taken;
			drops += 1;
			if (drops > RECONNECTS) {
				return yield* Effect.die(new Error(`The wait on ask ${askId} kept dropping.`));
			}
			yield* Effect.sleep(Math.min(100 * 2 ** (drops - 1), 5_000) * (0.5 + Math.random()));
		}
	}).pipe(
		Effect.catchTag("CallerLeft", () => Effect.succeed(notYet(tool, askId))),
		Effect.catchTag("AskNotFound", Effect.die),
	);

/** A move on an ask, waited on when the caller gave a wait, and otherwise started as a task. */
const settle = (
	tool: Tool,
	caller: Caller,
	space: SpaceClient,
	askId: string,
	turn: number,
	at: string,
	wait: Wait | undefined,
): Effect.Effect<AskOutcome, never, Spaces> =>
	wait === undefined
		? Effect.succeed({ outcome: "started", taskId: taskIdOf(askId, turn), askId, turn, at })
		: replyTo(caller, space, askId, turn, tool, wait);

const spaceOf = (caller: Caller) =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		return spaces.of(caller.space);
	});

/** Who opened an ask, and with what client, as the space records it. */
const raisedBy = (caller: Caller, client: string | undefined) => ({
	actor: caller.actor,
	...(client === undefined ? {} : { client }),
});

/** Opens an ask, or rejoins the one a retried call opened, then settles it. */
const opened = (
	tool: Tool,
	caller: Caller,
	open: (space: SpaceClient) => Effect.Effect<Ask, ContentInvalid>,
	wait: Wait | undefined,
) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		const ask = yield* open(space);
		return yield* settle(tool, caller, space, ask.id, ...latestTurn(ask), wait);
	}).pipe(Effect.catchTag("ContentInvalid", (error) => Effect.succeed(refused(error.reason))));

export const askQuestion = (
	caller: Caller,
	input: QuestionInput,
	client: string | undefined,
	wait: Wait | undefined,
) =>
	opened(
		"ask_question",
		caller,
		(space) => space.open({ kind: "question", input, ...raisedBy(caller, client) }),
		wait,
	);

export const requestReview = (
	caller: Caller,
	input: ReviewInput,
	client: string | undefined,
	wait: Wait | undefined,
) =>
	opened(
		"request_review",
		caller,
		(space) => space.open({ kind: "review", input, ...raisedBy(caller, client) }),
		wait,
	);

export const sendBriefing = (
	caller: Caller,
	input: BriefingInput,
	client: string | undefined,
	wait: Wait | undefined,
) =>
	opened(
		"send_briefing",
		caller,
		(space) => space.open({ kind: "briefing", input, ...raisedBy(caller, client) }),
		wait,
	);

export const answerFollowUp = (caller: Caller, input: FollowUpInput, wait: Wait | undefined) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		const ask = yield* space.answerFollowUp(input);
		const answer = ask.thread.at(-1);
		return yield* settle(
			"answer_follow_up",
			caller,
			space,
			ask.id,
			ask.thread.length,
			answer?.at ?? ask.updatedAt,
			wait,
		);
	}).pipe(
		Effect.catchTags({
			AskNotFound: () => Effect.succeed(refused(`No ask "${input.askId}".`)),
			AskClosed: () =>
				Effect.succeed(refused("That ask is closed; the person has already decided.")),
			NotYourTurn: () =>
				Effect.succeed(
					refused(
						"The person has not asked anything back on that ask, so there is nothing to answer.",
					),
				),
			ContentInvalid: (error) => Effect.succeed(refused(error.reason)),
		}),
	);

export const answerBriefing = (
	caller: Caller,
	input: BriefingAnswerInput,
	wait: Wait | undefined,
) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		// A retried move rejoins the turn it first took, which may no longer be the last.
		const { ask, turn } = yield* space.answerBriefing(input);
		const answer = ask.thread[turn - 1];
		return yield* settle(
			"answer_briefing",
			caller,
			space,
			ask.id,
			turn,
			answer?.at ?? ask.updatedAt,
			wait,
		);
	}).pipe(
		Effect.catchTags({
			AskNotFound: () => Effect.succeed(refused(`No briefing "${input.askId}".`)),
			AskClosed: () =>
				Effect.succeed(
					refused(
						"The person closed that briefing. Act on what they said, or ask a new question if something is still unclear.",
					),
				),
			NotYourTurn: () =>
				Effect.succeed(
					refused(
						"The person has not replied on that briefing since your last answers, so there is nothing to answer yet.",
					),
				),
			ContentInvalid: (error) => Effect.succeed(refused(error.reason)),
		}),
	);

/** A task as its agent polls it. */
const taskView = (
	taskId: string,
	state: TaskState,
	pollMs: PollIntervals,
	briefing: BriefingAsk | undefined,
): Effect.Effect<TaskView> => {
	const times = {
		taskId,
		createdAt: state.createdAt,
		lastUpdatedAt: state.lastUpdatedAt,
		pollIntervalMs: pollEvery(state.createdAt, Date.now(), pollMs),
	};
	switch (state.status) {
		case "working":
			return Effect.succeed({ ...times, status: "working", message: WAITING_FOR_THE_PERSON });
		case "cancelled":
			return Effect.succeed({ ...times, status: "cancelled" });
		case "completed":
			return state.reply === null
				? Effect.die(new Error(`Task ${taskId} completed with no reply.`))
				: Effect.succeed({ ...times, status: "completed", ...replied(state.reply, briefing) });
	}
};

/** Runs a task request against the task's ask; an ask or turn the space does not hold is no task. */
const task = (
	caller: Caller,
	taskId: string,
	pollMs: PollIntervals,
	program: (
		space: SpaceClient,
		askId: string,
		turn: number,
	) => Effect.Effect<TaskState, AskNotFound>,
): Effect.Effect<TaskView | null, never, Spaces> =>
	Option.match(taskOf(taskId), {
		onNone: () => Effect.succeed(null),
		onSome: ({ askId, turn }) =>
			Effect.gen(function* () {
				const space = yield* spaceOf(caller);
				const state = yield* program(space, askId, turn);
				return yield* taskView(taskId, state, pollMs, yield* briefingFor(space, state.reply));
			}).pipe(Effect.catchTag("AskNotFound", () => Effect.succeed(null))),
	});

export const followTask = (
	caller: Caller,
	taskId: string,
	pollMs: PollIntervals = POLL_INTERVALS,
) => task(caller, taskId, pollMs, (space, askId, turn) => space.followTask(askId, turn, pollMs));

export const cancelTask = (
	caller: Caller,
	taskId: string,
	pollMs: PollIntervals = POLL_INTERVALS,
) => task(caller, taskId, pollMs, (space, askId, turn) => space.cancelTask(askId, turn));

export const createUpload = (caller: Caller, contentType: ImageType) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		const issued: IssuedUpload = { outcome: "issued", ...(yield* space.createUpload(contentType)) };
		return issued;
	});
