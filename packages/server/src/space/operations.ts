import {
	type Actor,
	type AgentEntry,
	type Ask,
	type AskPage,
	type Block,
	type BriefingAnswerInput,
	type BriefingInput,
	type BriefingPoint,
	answerEntries,
	answersProblem,
	type FollowUpInput,
	foldBriefing,
	type ImageType,
	type QuestionInput,
	type Reply,
	type ReviewInput,
	type Snapshot,
	type ToolReply,
	type UploadReceipt,
} from "@loopbacktools/protocol";
import { Clock, Effect, Option } from "effect";
import {
	type AskRecord,
	briefingPrompt,
	type EntryRecord,
	checkReply,
	checkSize,
	fingerprint,
	imagesIn,
	questionPrompt,
	REATTACH_WINDOW_MS,
	reviewPrompt,
	sha256,
	statusAfter,
	toAsk,
} from "../domain/ask.ts";
import {
	AskClosed,
	AskNotFound,
	ContentInvalid,
	NotYourTurn,
	TicketInvalid,
	UploadExpired,
	UploadNotFound,
	UploadRejected,
} from "../domain/errors.ts";
import { Host, Presence } from "./services.ts";
import { AskStore, TicketStore, UploadStore } from "./store.ts";

/** How many closed asks a snapshot carries. */
export const RECENT_LIMIT = 50;

/** How long an upload ticket stays usable. */
export const UPLOAD_TTL_MS = 15 * 60 * 1000;

/** How long an event ticket stays usable: long enough to open a socket, too short to be worth stealing. */
export const TICKET_TTL_MS = 60 * 1000;

/** The largest image an upload ticket accepts. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** A question, review or briefing an agent is opening, with the MCP client that sent it when known. */
export type OpenRequest = (
	| { readonly kind: "question"; readonly input: QuestionInput }
	| { readonly kind: "review"; readonly input: ReviewInput }
	| { readonly kind: "briefing"; readonly input: BriefingInput }
) & {
	readonly client?: string;
	/** Whose agent is asking. A retried call is only recognised as the same person's. */
	readonly actor: Actor;
};

/** An upload ticket as the space issues it. The worker turns `token` into a URL. */
export interface IssuedUpload {
	readonly uploadId: string;
	readonly spaceId: string;
	readonly token: string;
	readonly contentType: ImageType;
	readonly expiresAt: string;
	readonly maxBytes: number;
}

/** A reply the space holds for an agent, with the thread entry it is, so the agent can take it. */
export interface Delivery extends ToolReply {
	readonly seq: number;
}

/** An upload ticket that has been claimed for one upload. */
export interface ClaimedUpload {
	readonly uploadId: string;
	readonly contentType: ImageType;
	readonly maxBytes: number;
}

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

/** A fresh 256-bit secret, URL- and subprotocol-safe. */
const secret = () =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

const findAsk = Effect.fnUntraced(function* (askId: string) {
	const store = yield* AskStore;
	const found = yield* store.find(askId);
	if (Option.isNone(found)) return yield* new AskNotFound({ askId });
	return found.value;
});

/** How often an agent's waiting is written down: often enough for the reattach window, no more. */
const NOTE_WAITING_EVERY_MS = 60_000;

/** Writes down that an agent is waiting on the ask, unless that was done within the last minute. */
const noteWaiting = Effect.fnUntraced(function* (record: AskRecord, at: string) {
	const since =
		record.lastWaitedAt === null ? Infinity : Date.parse(at) - Date.parse(record.lastWaitedAt);
	if (since < NOTE_WAITING_EVERY_MS) return;
	const store = yield* AskStore;
	yield* store.touchWaited(record.id, at);
});

/** Whether an agent is waiting on the ask: blocked on it over a wait socket, or polling it as a task. */
const isWaiting = Effect.fnUntraced(function* (askId: string) {
	const host = yield* Host;
	const presence = yield* Presence;
	return host.waiters(askId) > 0 || presence.isWaiting(askId);
});

/** The ask in its wire shape, with its thread and whether an agent is waiting on it. */
const view = Effect.fnUntraced(function* (record: AskRecord) {
	const store = yield* AskStore;
	return toAsk(record, yield* store.thread(record.id), yield* isWaiting(record.id));
});

/** The asks in their wire shape, leaving out any whose thread can't be read. */
const views = Effect.fnUntraced(function* (records: readonly AskRecord[]) {
	const store = yield* AskStore;
	const host = yield* Host;
	const presence = yield* Presence;
	const threads = yield* store.threads(records.map((record) => record.id));
	return records.flatMap((record) => {
		const thread = threads.get(record.id);
		const waiting = host.waiters(record.id) > 0 || presence.isWaiting(record.id);
		return thread === undefined ? [] : [toAsk(record, thread, waiting)];
	});
});

const announce = Effect.fnUntraced(function* (type: "ask.opened" | "ask.updated", ask: Ask) {
	const host = yield* Host;
	yield* host.broadcast({ type, ask });
});

/** Every inbox hears the ask as it now stands, since an agent started or stopped following it. */
const announceFollowing = (askId: string) =>
	Effect.flatMap(findAsk(askId), view).pipe(
		Effect.flatMap((ask) => announce("ask.updated", ask)),
		Effect.ignoreCause({ log: true }),
	);

/** A poll begins on the ask; inboxes hear it when that starts the ask being followed. */
const follow = Effect.fnUntraced(function* (askId: string) {
	const host = yield* Host;
	const presence = yield* Presence;
	if ((yield* presence.begin(askId)) && host.waiters(askId) === 0) yield* announceFollowing(askId);
});

/** A poll ends; inboxes hear it if no other begins within the grace and no agent is blocked on it. */
const unfollow = Effect.fnUntraced(function* (askId: string) {
	const host = yield* Host;
	const presence = yield* Presence;
	yield* presence.end(
		askId,
		Effect.suspend(() => (host.waiters(askId) === 0 ? announceFollowing(askId) : Effect.void)),
	);
});

/** Every image the blocks show must be an upload this space holds. */
const checkImages = Effect.fnUntraced(function* (blocks: readonly Block[]) {
	const uploads = yield* UploadStore;
	for (const uploadId of imagesIn(blocks)) {
		const upload = yield* uploads.find(uploadId);
		if (Option.isNone(upload) || upload.value.status !== "stored") {
			return yield* new ContentInvalid({
				reason: `No uploaded image "${uploadId}". Upload it with create_image_upload first.`,
			});
		}
	}
});

/** Everything a set of briefing points shows. */
const blocksOf = (points: readonly BriefingPoint[]): Block[] =>
	points.flatMap((point) => point.content ?? []);

/**
 * Opens an ask, or rejoins the one a retried call opened. A retry is the same question or review,
 * from the same client and project, while the ask is still open or holds a reply that never
 * reached the agent, and only if an agent waited on it within the reattach window.
 */
export const open = Effect.fn("Space.open")(function* (request: OpenRequest) {
	const store = yield* AskStore;
	yield* checkSize(
		request.input,
		`Show the part that matters, or split it into several ${request.kind}s.`,
	);
	const at = yield* now;
	const key = yield* fingerprint({
		kind: request.kind,
		client: request.client ?? null,
		actor: request.actor.id,
		input: request.input,
	});
	const since = new Date(Date.parse(at) - REATTACH_WINDOW_MS).toISOString();
	const retried = yield* store.findRetry(key, since);
	if (Option.isSome(retried)) {
		yield* noteWaiting(retried.value, at);
		return yield* view(retried.value);
	}
	if (request.kind === "review") {
		yield* checkImages(request.input.content);
		if (request.input.revises !== undefined) {
			const revised = yield* store.find(request.input.revises);
			if (Option.isNone(revised) || revised.value.kind !== "review") {
				return yield* new ContentInvalid({
					reason: `"revises" names no review: "${request.input.revises}".`,
				});
			}
		}
	}
	const head = {
		id: crypto.randomUUID(),
		key,
		status: "awaiting_human",
		project: request.input.project ?? null,
		client: request.client ?? null,
		raisedBy: request.actor,
		createdAt: at,
		updatedAt: at,
		closedAt: null,
		lastWaitedAt: at,
	} as const;
	let record: AskRecord;
	switch (request.kind) {
		case "question":
			record = { ...head, kind: "question", prompt: questionPrompt(request.input) };
			break;
		case "review":
			record = {
				...head,
				kind: "review",
				prompt: reviewPrompt(request.input),
				revises: request.input.revises ?? null,
			};
			break;
		case "briefing": {
			const prompt = yield* briefingPrompt(request.input);
			yield* checkImages(blocksOf(request.input.sections.flatMap((section) => section.points)));
			record = { ...head, kind: "briefing", prompt };
			break;
		}
	}
	yield* store.insert(record);
	const ask = yield* view(record);
	yield* announce("ask.opened", ask);
	return ask;
});

/**
 * Records the agent's answer to a question the person asked back, and hands the move back to them.
 * Sending the same answer again while it is already their move is a retry, and changes nothing.
 */
export const answerFollowUp = Effect.fn("Space.answerFollowUp")(function* (input: FollowUpInput) {
	const store = yield* AskStore;
	const presence = yield* Presence;
	const record = yield* findAsk(input.askId);
	if (record.kind === "briefing") {
		return yield* new ContentInvalid({
			reason: "This is a briefing: answer it with answer_briefing, on each point.",
		});
	}
	if (record.status === "closed") return yield* new AskClosed({ askId: record.id });
	if (record.status === "awaiting_human") {
		const thread = yield* store.thread(record.id);
		const last = thread.at(-1)?.entry;
		const same =
			last?.author === "agent" &&
			last.answer === input.answer &&
			JSON.stringify(last.content ?? []) === JSON.stringify(input.content ?? []);
		if (same) return toAsk(record, thread, presence.isWaiting(record.id));
		return yield* new NotYourTurn({ askId: record.id, turn: "human" });
	}
	yield* checkSize({ answer: input.answer, content: input.content });
	yield* checkImages(input.content ?? []);
	const at = yield* now;
	yield* store.transaction(
		Effect.gen(function* () {
			// Answering the person's question shows the agent had it.
			yield* store.markAllDelivered(record.id, at);
			yield* store.append(record.id, {
				author: "agent",
				answer: input.answer,
				...(input.content === undefined ? {} : { content: input.content }),
				at,
			});
			yield* store.setStatus(record.id, "awaiting_human", at);
			yield* store.touchWaited(record.id, at);
		}),
	);
	const ask = yield* view({ ...record, status: "awaiting_human", updatedAt: at });
	yield* announce("ask.updated", ask);
	return ask;
});

/** Whether a recorded agent entry is this answer, as a retried move would send it again. */
const sameAnswer = (entry: AgentEntry, answer: BriefingAnswerInput["answers"][number]) =>
	entry.point === answer.point &&
	entry.answer === answer.answer &&
	JSON.stringify(entry.content ?? []) === JSON.stringify(answer.content ?? []) &&
	JSON.stringify((entry.points ?? []).map(({ id: _, ...point }) => point)) ===
		JSON.stringify(answer.points ?? []);

/** The agent's move on a briefing as recorded, and its turn: the thread entry the move ended with. */
export interface BriefingMove {
	readonly ask: Ask;
	readonly turn: number;
}

/**
 * The turn a retried move rejoins, if it is one: the agent's latest move is this same move, and
 * nothing the person sent since has reached the agent. Once any reply after the move has reached it,
 * the agent has seen past the move, so the same words again are a new move, never a retry.
 */
const rejoins = (
	thread: readonly EntryRecord[],
	answers: BriefingAnswerInput["answers"],
): number | undefined => {
	const last = thread.findLastIndex((row) => row.entry.author === "agent");
	if (last + 1 < answers.length) return undefined;
	const move = thread.slice(last + 1 - answers.length, last + 1);
	const same = move.every((row, n) => {
		const answer = answers[n];
		return row.entry.author === "agent" && answer !== undefined && sameAnswer(row.entry, answer);
	});
	if (!same) return undefined;
	const since = thread.slice(last + 1);
	return since.every((row) => row.deliveredAt === null) ? thread[last]?.seq : undefined;
};

/**
 * Records the agent's answers on a briefing, one thread entry per point, numbering any sub-points,
 * and hands the move back to the person. A move sent again before its reply reached the agent is a
 * retry: it rejoins the move it repeats, and changes nothing.
 */
export const answerBriefing = Effect.fn("Space.answerBriefing")(function* (
	input: BriefingAnswerInput,
) {
	const store = yield* AskStore;
	const at = yield* now;
	const { record, turn, made } = yield* store.transaction(
		Effect.gen(function* () {
			const found = yield* findAsk(input.askId);
			if (found.kind !== "briefing") {
				return yield* new ContentInvalid({
					reason: `This is a ${found.kind}, not a briefing: answer_briefing answers only briefings.`,
				});
			}
			const thread = yield* store.thread(found.id);
			const rejoined = rejoins(thread, input.answers);
			if (rejoined !== undefined) return { record: found, turn: rejoined, made: false };
			if (found.status === "closed") return yield* new AskClosed({ askId: found.id });
			if (found.status === "awaiting_human") {
				return yield* new NotYourTurn({ askId: found.id, turn: "human" });
			}
			yield* checkSize(input.answers);
			yield* checkImages(
				input.answers.flatMap((answer) => [
					...(answer.content ?? []),
					...blocksOf(answer.points ?? []),
				]),
			);
			const tree = foldBriefing(
				found.prompt,
				thread.map((row) => row.entry),
			);
			const problem = answersProblem(tree, input.answers);
			if (problem !== null) return yield* new ContentInvalid({ reason: problem });
			// Answering the person's replies shows the agent had them.
			yield* store.markAllDelivered(found.id, at);
			let last = 0;
			for (const entry of answerEntries(tree, input.answers, at)) {
				last = (yield* store.append(found.id, entry)).seq;
			}
			yield* store.setStatus(found.id, "awaiting_human", at);
			yield* store.touchWaited(found.id, at);
			const updated: AskRecord = { ...found, status: "awaiting_human", updatedAt: at };
			return { record: updated, turn: last, made: true };
		}),
	);
	const ask = yield* view(record);
	if (made) yield* announce("ask.updated", ask);
	const move: BriefingMove = { ask, turn };
	return move;
});

/**
 * The reply the agent has not yet taken, or `null` when there is none. It stays the agent's to take
 * until `markDelivered` says it reached them, so a wait whose caller has gone loses nothing.
 */
export const takeReply = Effect.fn("Space.takeReply")(function* (askId: string) {
	const store = yield* AskStore;
	yield* findAsk(askId);
	const entry = yield* store.undelivered(askId);
	if (Option.isNone(entry) || entry.value.entry.author !== "human") return null;
	const delivery: Delivery = { askId, reply: entry.value.entry.reply, seq: entry.value.seq };
	return delivery;
});

/**
 * An agent has started waiting on the ask: its wait socket is open, and counted. It is written down
 * for the reattach window, and inboxes hear it when that starts the ask being followed. True when a
 * reply is already there for it to take.
 */
export const startWaiting = Effect.fn("Space.startWaiting")(function* (askId: string) {
	const host = yield* Host;
	const presence = yield* Presence;
	const record = yield* findAsk(askId);
	yield* noteWaiting(record, yield* now);
	if (host.waiters(askId) === 1 && !presence.isWaiting(askId)) yield* announceFollowing(askId);
	return (yield* takeReply(askId)) !== null;
});

/**
 * An agent's wait socket has closed. When none is left and no task follows the ask, inboxes hear at
 * once that no agent is waiting. An ask erased meanwhile has no one left to tell.
 */
export const stopWaiting = Effect.fn("Space.stopWaiting")(
	function* (askId: string) {
		const host = yield* Host;
		const presence = yield* Presence;
		const record = yield* findAsk(askId);
		yield* noteWaiting(record, yield* now);
		if (host.waiters(askId) === 0 && !presence.isWaiting(askId)) yield* announceFollowing(askId);
	},
	Effect.catchTag("AskNotFound", () => Effect.void),
);

/** Records that the agent was handed the reply at `seq`: a retry no longer collects it. */
export const markDelivered = Effect.fn("Space.markDelivered")(function* (
	askId: string,
	seq: number,
) {
	const store = yield* AskStore;
	yield* store.markDelivered(askId, seq, yield* now);
	return null;
});

/**
 * Where an agent's background task stands. A task follows one of the agent's turns, numbered by
 * the thread entry it ended with (0 for opening the ask), and completes with the first reply the
 * person gives after it.
 */
export interface TaskState {
	readonly status: "working" | "completed" | "cancelled";
	readonly createdAt: string;
	readonly lastUpdatedAt: string;
	readonly reply: Delivery | null;
}

/** The task for turn `afterSeq` of an ask: when it started, and the reply that ends it, if given. */
const locateTask = Effect.fnUntraced(function* (askId: string, afterSeq: number) {
	const store = yield* AskStore;
	const record = yield* findAsk(askId);
	const thread = yield* store.thread(askId);
	let startedAt: string | undefined = afterSeq === 0 ? record.createdAt : undefined;
	let answer:
		| {
				readonly seq: number;
				readonly at: string;
				readonly reply: Delivery;
				readonly delivered: boolean;
		  }
		| undefined;
	for (const row of thread) {
		if (row.seq === afterSeq && row.entry.author === "agent") startedAt = row.entry.at;
		if (answer === undefined && row.seq > afterSeq && row.entry.author === "human") {
			answer = {
				seq: row.seq,
				at: row.entry.at,
				reply: { askId, reply: row.entry.reply, seq: row.seq },
				delivered: row.deliveredAt !== null,
			};
		}
	}
	// A turn this ask never had names no task.
	if (startedAt === undefined) return yield* new AskNotFound({ askId });
	return { record, startedAt, answer };
});

/**
 * One poll of an agent's background task. While it is working, each poll keeps the ask showing an
 * agent following it; once the person replies, it completes with that reply, every time it is asked.
 */
export const followTask = Effect.fn("Space.followTask")(function* (
	askId: string,
	afterSeq: number,
) {
	const store = yield* AskStore;
	const { record, startedAt, answer } = yield* locateTask(askId, afterSeq);
	if (answer !== undefined) {
		if (!answer.delivered) yield* store.markDelivered(askId, answer.seq, yield* now);
		const state: TaskState = {
			status: "completed",
			createdAt: startedAt,
			lastUpdatedAt: answer.at,
			reply: answer.reply,
		};
		return state;
	}
	const cancelledAt = yield* store.taskCancelledAt(askId, afterSeq);
	if (Option.isSome(cancelledAt)) {
		const state: TaskState = {
			status: "cancelled",
			createdAt: startedAt,
			lastUpdatedAt: cancelledAt.value,
			reply: null,
		};
		return state;
	}
	yield* follow(askId);
	yield* unfollow(askId);
	yield* noteWaiting(record, yield* now);
	const state: TaskState = {
		status: "working",
		createdAt: startedAt,
		lastUpdatedAt: startedAt,
		reply: null,
	};
	return state;
});

/**
 * The agent stops following a background task. The ask stays open, and the person can still
 * answer it; the inbox stops showing anyone waiting. A task that already completed stays completed.
 */
export const cancelTask = Effect.fn("Space.cancelTask")(function* (
	askId: string,
	afterSeq: number,
) {
	const store = yield* AskStore;
	const presence = yield* Presence;
	const { startedAt, answer } = yield* locateTask(askId, afterSeq);
	if (answer !== undefined) {
		const state: TaskState = {
			status: "completed",
			createdAt: startedAt,
			lastUpdatedAt: answer.at,
			reply: answer.reply,
		};
		return state;
	}
	const at = yield* now;
	yield* store.cancelTask(askId, afterSeq, at);
	if (yield* presence.drop(askId)) yield* announceFollowing(askId);
	const state: TaskState = {
		status: "cancelled",
		createdAt: startedAt,
		lastUpdatedAt: at,
		reply: null,
	};
	return state;
});

/** Records a person's reply, wakes the agent waiting for it, and tells every inbox. */
export const reply = Effect.fn("Space.reply")(function* (askId: string, answer: Reply, by: Actor) {
	const store = yield* AskStore;
	const host = yield* Host;
	const at = yield* now;
	const { record, status } = yield* store.transaction(
		Effect.gen(function* () {
			const found = yield* findAsk(askId);
			const thread = (yield* store.thread(askId)).map((row) => row.entry);
			yield* checkReply(found, thread, answer);
			const next = statusAfter(found, thread, answer);
			yield* store.append(askId, { author: "human", reply: answer, by, at });
			yield* store.setStatus(askId, next, at);
			return { record: found, status: next };
		}),
	);
	yield* host.wake(askId);
	const ask = yield* view({
		...record,
		status,
		updatedAt: at,
		closedAt: status === "closed" ? at : null,
	});
	yield* announce("ask.updated", ask);
	return ask;
});

export const get = (askId: string) => Effect.flatMap(findAsk(askId), view);

/** Every open ask and the most recently closed. */
export const snapshot = Effect.gen(function* () {
	const store = yield* AskStore;
	const current: Snapshot = {
		open: yield* views(yield* store.open),
		recent: yield* views((yield* store.closed(undefined, RECENT_LIMIT)).records),
	};
	return current;
});

/** A page of closed asks, newest first. */
export const history = Effect.fn("Space.history")(function* (
	before: string | undefined,
	limit: number,
) {
	const store = yield* AskStore;
	const { records, nextBefore } = yield* store.closed(before, limit);
	const items = yield* views(records);
	const page: AskPage = { items, ...(nextBefore === null ? {} : { nextBefore }) };
	return page;
});

/** Issues a single-use ticket to upload one image. */
export const createUpload = Effect.fn("Space.createUpload")(function* (contentType: ImageType) {
	const uploads = yield* UploadStore;
	const host = yield* Host;
	const at = yield* now;
	const token = secret();
	const issued: IssuedUpload = {
		uploadId: crypto.randomUUID(),
		spaceId: host.spaceId,
		token,
		contentType,
		expiresAt: new Date(Date.parse(at) + UPLOAD_TTL_MS).toISOString(),
		maxBytes: UPLOAD_MAX_BYTES,
	};
	yield* uploads.insert({
		id: issued.uploadId,
		tokenHash: yield* sha256(token),
		contentType,
		maxBytes: issued.maxBytes,
		status: "pending",
		size: null,
		createdAt: at,
		expiresAt: issued.expiresAt,
	});
	return issued;
});

/** Uses up an upload ticket. Once claimed it is spent, whether or not the upload then succeeds. */
export const claimUpload = Effect.fn("Space.claimUpload")(function* (
	token: string,
	contentType: string,
) {
	const uploads = yield* UploadStore;
	const found = yield* uploads.findByToken(yield* sha256(token));
	if (Option.isNone(found)) return yield* new UploadNotFound();
	const upload = found.value;
	if (
		upload.status !== "pending" ||
		Date.parse(upload.expiresAt) <= (yield* Clock.currentTimeMillis)
	) {
		return yield* new UploadExpired();
	}
	const declared = contentType.split(";")[0]?.trim().toLowerCase();
	if (declared !== upload.contentType) {
		return yield* new UploadRejected({
			reason: `This ticket is for ${upload.contentType}, not ${declared || "an unnamed type"}.`,
		});
	}
	yield* uploads.setStatus(upload.id, "claimed", null);
	const claimed: ClaimedUpload = {
		uploadId: upload.id,
		contentType: upload.contentType,
		maxBytes: upload.maxBytes,
	};
	return claimed;
});

/** Records that a claimed upload's bytes are stored. */
export const completeUpload = Effect.fn("Space.completeUpload")(function* (
	uploadId: string,
	size: number,
) {
	const uploads = yield* UploadStore;
	const found = yield* uploads.find(uploadId);
	if (Option.isNone(found) || found.value.status !== "claimed") return yield* new UploadNotFound();
	yield* uploads.setStatus(uploadId, "stored", size);
	const receipt: UploadReceipt = { uploadId, contentType: found.value.contentType, size };
	return receipt;
});

/** A stored upload's type and size. */
export const findUpload = Effect.fn("Space.findUpload")(function* (uploadId: string) {
	const uploads = yield* UploadStore;
	const found = yield* uploads.find(uploadId);
	if (Option.isNone(found) || found.value.status !== "stored") return yield* new UploadNotFound();
	const receipt: UploadReceipt = {
		uploadId,
		contentType: found.value.contentType,
		size: found.value.size ?? 0,
	};
	return receipt;
});

/** A one-time pass onto the space's event socket, for the actor named. */
export interface IssuedTicket {
	readonly spaceId: string;
	readonly secret: string;
	readonly expiresAt: string;
}

/** Issues a one-time pass onto the event socket, held only as its hash. */
export const issueTicket = Effect.fn("Space.issueTicket")(function* (actorId: string) {
	const tickets = yield* TicketStore;
	const host = yield* Host;
	const at = yield* now;
	yield* tickets.purge(at);
	const issued: IssuedTicket = {
		spaceId: host.spaceId,
		secret: secret(),
		expiresAt: new Date(Date.parse(at) + TICKET_TTL_MS).toISOString(),
	};
	yield* tickets.insert(yield* sha256(issued.secret), actorId, issued.expiresAt);
	return issued;
});

/** Spends an event ticket: who it was issued to, or `TicketInvalid` when it is unknown, used or expired. */
export const redeemTicket = Effect.fn("Space.redeemTicket")(function* (ticketSecret: string) {
	const tickets = yield* TicketStore;
	const at = yield* now;
	const taken = yield* tickets.take(yield* sha256(ticketSecret));
	if (Option.isNone(taken) || taken.value.expiresAt <= at) return yield* new TicketInvalid();
	return { actorId: taken.value.actorId };
});

/** Everything a space does, by name: what its object serves over RPC. */
export const operations = {
	open,
	answerFollowUp,
	answerBriefing,
	takeReply,
	markDelivered,
	followTask,
	cancelTask,
	reply,
	get,
	snapshot: () => snapshot,
	history,
	createUpload,
	claimUpload,
	completeUpload,
	findUpload,
	issueTicket,
	redeemTicket,
};

export type Operations = typeof operations;
