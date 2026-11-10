import type {
	Actor,
	Ask,
	AskKind,
	AskPage,
	BriefingAnswerInput,
	BriefingInput,
	EventTicket,
	FollowUpInput,
	ImageType,
	Problem,
	QuestionInput,
	Reply,
	ReviewInput,
	Snapshot,
	UploadReceipt,
	Whoami,
} from "@loopbacktools/protocol";

/**
 * The core's RPC: what every edge, public or hosted, calls on the `Core` entrypoint over a service
 * binding. The core owns it and versions it with its own semver. It is typed with the contract's
 * messages only, and knows nothing of any edge: not its routes, its MCP server, its gate or the
 * code it generates from the contract.
 */

/**
 * Who is calling: the space the edge's gate opened, and the person acting in it. The core has no
 * public address and trusts its callers to have established both.
 */
export interface Caller {
	readonly space: string;
	readonly actor: Actor;
}

/**
 * How long a blocking agent operation may hold its call for a reply, which is the edge's to say:
 * it follows its clients' timeouts and its Workers plan.
 */
export interface Wait {
	/** How long the call may wait before it answers that there is no reply yet. `Infinity` waits for it. */
	readonly budgetMs: number;
	/** How often the core calls `progress` while it waits. */
	readonly keepAliveMs: number;
	/**
	 * Tells the edge's client the call is alive, with a count of the laps waited. A callback over
	 * RPC: its rejecting means the caller has gone, and the core stops waiting.
	 */
	readonly progress: (step: number) => Promise<void>;
}

import type { PollIntervals } from "./domain/polling.ts";

export type { PollIntervals };

/** An answer the contract declares: its status and the body it carries. */
export interface Answer<Status extends number, Body> {
	readonly status: Status;
	readonly body: Body;
}

/** A refusal the contract declares, with its problem. */
export type Refusal<Status extends number> = Answer<Status, Problem>;

/** An uploaded image, streamed. */
export interface FileAnswer {
	readonly status: 200;
	readonly contentType: ImageType;
	readonly body: ReadableStream<Uint8Array>;
}

/**
 * The inbox's operations, named after the contract's operation ids, each taking the caller and the
 * operation's input and answering with one of the responses the contract declares for it.
 */
export interface InboxOperations {
	Session_whoami(caller: Caller, input: Record<string, never>): Promise<Answer<200, Whoami>>;
	EventTickets_issue(
		caller: Caller,
		input: Record<string, never>,
	): Promise<Answer<201, EventTicket>>;
	Snapshots_read(caller: Caller, input: Record<string, never>): Promise<Answer<200, Snapshot>>;
	Asks_list(
		caller: Caller,
		input: { readonly before?: string; readonly limit?: number },
	): Promise<Answer<200, AskPage>>;
	Asks_read(
		caller: Caller,
		input: { readonly id: string },
	): Promise<Answer<200, Ask> | Refusal<404>>;
	Asks_reply(
		caller: Caller,
		input: { readonly id: string; readonly reply: Reply },
	): Promise<Answer<200, Ask> | Refusal<404 | 409 | 422>>;
	Files_read(
		caller: Caller,
		input: { readonly uploadId: string },
	): Promise<FileAnswer | Refusal<404>>;
	/**
	 * The URL is the credential, so the caller is not consulted. `length` is the body's
	 * `Content-Length`, which the edge reads off the request.
	 */
	Uploads_store(
		caller: Caller,
		input: {
			readonly spaceId: string;
			readonly token: string;
			readonly "Content-Type": string;
			readonly length: number;
			readonly body: ReadableStream<Uint8Array> | null;
		},
	): Promise<Answer<201, UploadReceipt> | Refusal<404 | 410 | 413 | 422>>;
}

/** The contract's operation ids the core serves. */
export type Operation = keyof InboxOperations;

/** Every operation id the core serves, in the contract's order. */
export const OPERATIONS = [
	"Session_whoami",
	"EventTickets_issue",
	"Snapshots_read",
	"Asks_list",
	"Asks_read",
	"Asks_reply",
	"Files_read",
	"Uploads_store",
] as const satisfies readonly Operation[];

/** The compiler's check that `OPERATIONS` lists every operation. */
const everyOperationListed: [Exclude<Operation, (typeof OPERATIONS)[number]>] extends [never]
	? true
	: Exclude<Operation, (typeof OPERATIONS)[number]> = true;
void everyOperationListed;

/**
 * Just the inbox's operations, picked off a binding to the core, each going through it. A stub
 * answers to every name, so code that wants exactly the contract's operations, as a router
 * generated from it does, takes these.
 */
export const operationsOf = (core: InboxOperations): InboxOperations => ({
	Session_whoami: (caller, input) => core.Session_whoami(caller, input),
	EventTickets_issue: (caller, input) => core.EventTickets_issue(caller, input),
	Snapshots_read: (caller, input) => core.Snapshots_read(caller, input),
	Asks_list: (caller, input) => core.Asks_list(caller, input),
	Asks_read: (caller, input) => core.Asks_read(caller, input),
	Asks_reply: (caller, input) => core.Asks_reply(caller, input),
	Files_read: (caller, input) => core.Files_read(caller, input),
	Uploads_store: (caller, input) => core.Uploads_store(caller, input),
});

/** A reply as the agent receives it: the contract's reply, and what it means in words. */
export interface Replied {
	readonly askId: string;
	readonly reply: Reply;
	readonly message: string;
}

/**
 * The ask an outcome is about: its id, its kind, and the client that opened it when it said, which
 * may not be the one calling, so an edge can record what agents do without reading the ask again.
 */
export interface AskNamed {
	readonly askId: string;
	readonly kind: AskKind;
	readonly client?: string;
}

/** What an agent's ask, or its next move on one, comes to. */
export type AskOutcome =
	/** No wait was given: the agent follows the reply as a task, `<askId>:<turn>`. */
	| ({
			readonly outcome: "started";
			readonly taskId: string;
			readonly turn: number;
			readonly at: string;
	  } & AskNamed)
	/** The person replied while the call waited. */
	| ({ readonly outcome: "replied" } & Replied & AskNamed)
	/** The wait ran out, or its caller went: calling again with the same input rejoins the ask. */
	| ({ readonly outcome: "waiting"; readonly message: string } & AskNamed)
	/**
	 * The space would not take it, and says why, with the status and problem code the contract
	 * answers a refused agent operation with: 404 for no such ask, 409 for an ask that is closed or
	 * the person's move, 422 for content that doesn't fit.
	 */
	| {
			readonly outcome: "refused";
			readonly status: 404 | 409 | 422;
			readonly code: "not_found" | "ask.closed" | "ask.human_turn" | "content.invalid";
			readonly message: string;
	  };

/** A background task as its agent polls it. */
export type TaskView = {
	readonly taskId: string;
	readonly createdAt: string;
	readonly lastUpdatedAt: string;
	/** How long the agent should wait before polling again. */
	readonly pollIntervalMs: number;
} & (
	| { readonly status: "working"; readonly message: string }
	| ({ readonly status: "completed" } & Replied)
	| { readonly status: "cancelled" }
);

/** A one-time ticket to upload an image. */
export interface IssuedUpload {
	readonly outcome: "issued";
	readonly uploadId: string;
	readonly spaceId: string;
	readonly token: string;
	readonly contentType: ImageType;
	readonly expiresAt: string;
	readonly maxBytes: number;
}

/**
 * What an agent does: open an ask, answer the person, follow and cancel its tasks, and upload
 * images. Each operation that brings a reply takes a `Wait` to block for it, and without one starts
 * a task. Every message is the wording agents are given, the same through every edge.
 */
export interface AgentOperations {
	askQuestion(
		caller: Caller,
		input: QuestionInput,
		client?: string,
		wait?: Wait,
	): Promise<AskOutcome>;
	requestReview(
		caller: Caller,
		input: ReviewInput,
		client?: string,
		wait?: Wait,
	): Promise<AskOutcome>;
	sendBriefing(
		caller: Caller,
		input: BriefingInput,
		client?: string,
		wait?: Wait,
	): Promise<AskOutcome>;
	answerFollowUp(caller: Caller, input: FollowUpInput, wait?: Wait): Promise<AskOutcome>;
	answerBriefing(caller: Caller, input: BriefingAnswerInput, wait?: Wait): Promise<AskOutcome>;
	/** One poll of a task, `null` for a task the caller's space does not hold. */
	followTask(caller: Caller, taskId: string, pollMs?: PollIntervals): Promise<TaskView | null>;
	/** Stops following a task, leaving its ask open; `null` for a task the space does not hold. */
	cancelTask(caller: Caller, taskId: string, pollMs?: PollIntervals): Promise<TaskView | null>;
	createUpload(caller: Caller, contentType: ImageType): Promise<IssuedUpload>;
}

/** Everything the core's `Core` entrypoint serves. */
export interface CoreRpc extends InboxOperations, AgentOperations {
	/**
	 * WebSocket upgrades only: an inbox's events, at `/spaces/id/<spaceId>/events?ticket=<secret>`,
	 * sent the space as it stands first. Anything that isn't an upgrade is answered 426.
	 */
	fetch(request: Request): Promise<Response>;
	/** Deletes a space's asks, tickets and files, for a host removing a tenant. */
	erase(space: string): Promise<void>;
	/** The revision of the contract this core speaks. An edge newer than its core is deployed first. */
	revision(): Promise<number>;
}
