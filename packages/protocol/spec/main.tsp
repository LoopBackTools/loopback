import "@typespec/http";
import "@typespec/openapi";
import "@typespec/versioning";

using Http;
using Versioning;
using OpenAPI;

// The Loopback contract. Everything the HTTP API accepts or returns, the shapes MCP tools take and
// give back, and the frames the event socket sends are declared here, and only here.

/**
 * Loopback puts what an agent needs from a person in front of them and hands the reply back.
 *
 * An agent asks over MCP; a person answers through this API, usually from the web inbox. Live updates
 * arrive over the WebSocket at `/api/v1/events`, which sends a `SnapshotEvent` and then `AskEvent`s.
 *
 * Every response names the code that answered: `Loopback-Revision`, the revision of this contract the
 * server writes, and `Loopback-Build`, when the deploy it is from was made. A client that names the
 * revision it writes in `Loopback-Revision` on its requests learns when the server is newer than
 * itself, and is refused with `409` and the code `reload` when it is the newer, as after a rollback.
 */
@versioned(Revisions)
@service(#{ title: "Loopback" })
@server("/api/v1", "Loopback API")
namespace Loopback;

/**
 * The contract's revisions, oldest first. Change the shape of any message and declare it here as a
 * new revision, marking what changed with `@added`, `@removed`, `@renamedFrom` or `@typeChangedFrom`:
 * every part of a deployment names the revision it writes, and newer code upgrades older messages.
 * Never edit a revision that has shipped; `revisions/` holds each one frozen, and a test fails when
 * the contract no longer emits it unchanged. See docs/design/versioned-messages.md.
 */
enum Revisions {
	r1: "1",

	/** Declares what an agent does, from which every edge generates its MCP tools. */
	r2: "2",
}

// --- vocabulary -----------------------------------------------------------------------------------

/**
 * What an agent is asking for: an answer to a question, a verdict on something it produced, or the
 * person's word on each point of something it explained.
 */
enum AskKind {
	question,
	review,
	briefing,
}

/** Where an ask stands. While it is open, it is either the person's move or the agent's. */
enum AskStatus {
	awaiting_human,
	awaiting_agent,
	closed,
}

/** Image formats an agent may upload for a review. */
union ImageType {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
}

// --- content --------------------------------------------------------------------------------------

/** Prose, copy or a plan, as GitHub-flavoured markdown. */
model MarkdownBlock {
	type: "markdown";
	@minLength(1) text: string;
}

/** Source code, shown highlighted. */
model CodeBlock {
	type: "code";
	@minLength(1) code: string;

	/** A language name the highlighter knows, such as `ts` or `python`. */
	language?: string;

	filename?: string;
}

/** A unified diff, as `git diff` prints it. */
model DiffBlock {
	type: "diff";
	@minLength(1) diff: string;
	filename?: string;
}

/** An image uploaded beforehand through an upload ticket. */
model ImageBlock {
	type: "image";
	@minLength(1) uploadId: string;
	caption?: string;
}

/** One piece of what is shown to the person. */
union Block {
	markdown: MarkdownBlock,
	code: CodeBlock,
	diff: DiffBlock,
	image: ImageBlock,
}

/** A choice offered with a question. */
model Choice {
	@minLength(1) @maxLength(80) label: string;
	description?: string;
}

/** One point of a briefing: a line the person sees folded, and what opens beneath it. */
model BriefingPoint {
	/** The point in one line, shown while it is folded. */
	@minLength(1) @maxLength(200) title: string;

	/** The point explained, as markdown, shown when the person opens it. */
	detail?: string;

	/** Anything to look at with it: code, a diff or an image. */
	content?: Block[];
}

/** A list of points under an optional heading. */
model BriefingSection {
	title?: string;
	@minItems(1) points: BriefingPoint[];
}

// --- what agents send -----------------------------------------------------------------------------

/**
 * A question for the person, with optional choices. They may always answer in their own words. All
 * of it together may be at most 256 KiB.
 */
model QuestionInput {
	/** The question, as markdown. */
	@minLength(1) question: string;

	/** Between two and six choices, offered as buttons. */
	@minItems(2) @maxItems(6) options?: Choice[];

	/** Whether the person may pick more than one choice. */
	multiple?: boolean;

	/** Background the person needs to answer, as markdown. */
	context?: string;

	/**
	 * The project you are working in: the name of the folder its repository is checked out in, the
	 * main checkout's even from a worktree (the folder holding `git rev-parse --git-common-dir`), or
	 * of the working directory outside one. The person works on many projects at once from one inbox;
	 * this is how they know who is asking.
	 */
	@minLength(1) project: string;
}

/**
 * Work put in front of the person for approval or feedback. All of it together may be at most
 * 256 KiB: show the part that matters, or split it into several reviews.
 */
model ReviewInput {
	@minLength(1) @maxLength(200) title: string;

	/** What is being reviewed, in order. */
	@minItems(1) content: Block[];

	/** What changed, or what to look at. */
	summary?: string;

	/** The id of the review this one revises, after changes were requested. */
	revises?: string;

	/**
	 * The project you are working in: the name of the folder its repository is checked out in, the
	 * main checkout's even from a worktree (the folder holding `git rev-parse --git-common-dir`), or
	 * of the working directory outside one. The person works on many projects at once from one inbox;
	 * this is how they know who is asking.
	 */
	@minLength(1) project: string;
}

/**
 * Something explained as points the person can reply on one at a time: findings, options, steps, a
 * list of changes. They may write on any point, or mark it resolved, and you answer on each point
 * they wrote on until every point is resolved. Points are numbered for you, straight through every
 * section: at most fifty. All of it together may be at most 256 KiB.
 */
model BriefingInput {
	@minLength(1) @maxLength(200) title: string;

	/** What this explains, and why, as markdown. */
	summary?: string;

	/** The points, in lists under optional headings. */
	@minItems(1) sections: BriefingSection[];

	/**
	 * The project you are working in: the name of the folder its repository is checked out in, the
	 * main checkout's even from a worktree (the folder holding `git rev-parse --git-common-dir`), or
	 * of the working directory outside one. The person works on many projects at once from one inbox;
	 * this is how they know who is asking.
	 */
	@minLength(1) project: string;
}

/** Your answer on one point of a briefing. */
model PointAnswer {
	/** The point's id, such as `3` or `3.1`. */
	@minLength(1) point: string;

	/** The answer, as markdown. */
	@minLength(1) answer: string;

	/** Anything new to look at alongside the answer. */
	content?: Block[];

	/**
	 * Sub-points this point breaks into, numbered beneath it (`3.1`, `3.2`, …), each of which the
	 * person can reply on in turn. Points go at most three levels deep.
	 */
	points?: BriefingPoint[];
}

/**
 * Your answers on a briefing, one per point: every point the person wrote on without resolving it,
 * and any other open point you have more to say on. All of it together may be at most 256 KiB.
 */
model BriefingAnswerInput {
	@minLength(1) askId: string;
	@minItems(1) answers: PointAnswer[];
}

/** The agent's answer to a question the person asked back, with its content at most 256 KiB. */
model FollowUpInput {
	@minLength(1) askId: string;

	/** The answer, as markdown. */
	@minLength(1) answer: string;

	/** Anything new to look at alongside the answer. */
	content?: Block[];
}

/** A request for somewhere to upload an image. */
model UploadRequest {
	contentType: ImageType;
}

/** Where to upload an image, once, before it expires. */
model UploadTicket {
	uploadId: string;

	/** Send the image here with `PUT` and its `Content-Type`. No credentials needed. */
	uploadUrl: string;

	expiresAt: utcDateTime;
	maxBytes: int32;

	/** A ready-to-run command that performs the upload; replace `FILE` with the image's path. */
	command: string;
}

/** A request for the address of the person's inbox. */
model InboxRequest {
	/** An ask to open directly. Leave it out for the inbox itself. */
	askId?: string;
}

/** Where the person reads and answers everything agents ask. */
model InboxLink {
	url: string;
}

// --- what people send -----------------------------------------------------------------------------

/** An answer to a question: the choices picked, words of their own, or both. */
model Answered {
	outcome: "answered";
	selected: string[];
	text?: string;
}

/** A review approved, with an optional note. */
model Approved {
	outcome: "approved";
	note?: string;
}

/** A review sent back with feedback. */
model ChangesRequested {
	outcome: "changes_requested";
	@minLength(1) feedback: string;
}

/** A question asked back before deciding. The ask stays open until the agent answers. */
model FollowUp {
	outcome: "follow_up";
	@minLength(1) question: string;
}

/** Declined without an answer. */
model Dismissed {
	outcome: "dismissed";
}

/** The person on one point of a briefing: words, resolved, or both. */
model PointReply {
	@minLength(1) point: string;

	/** What they said: a question, a push-back or a comment. */
	text?: string;

	/** Whether they are done with the point, and everything beneath it. */
	resolved?: boolean;
}

/**
 * Replies on the points of a briefing. The agent answers every point written on and left unresolved;
 * the briefing closes once every point is resolved.
 */
model Responded {
	outcome: "responded";
	@minItems(1) points: PointReply[];
}

/**
 * What a person replies. A `follow_up` hands the move to the agent; so does a `responded` that
 * leaves any point unresolved. Every other reply closes the ask.
 */
union Reply {
	answered: Answered,
	approved: Approved,
	changes_requested: ChangesRequested,
	follow_up: FollowUp,
	dismissed: Dismissed,
	responded: Responded,
}

// --- asks -----------------------------------------------------------------------------------------

/** A question as it is shown to the person. */
model QuestionPrompt {
	question: string;
	options: Choice[];
	multiple: boolean;
	context?: string;
}

/** A review as it is shown to the person. */
model ReviewPrompt {
	title: string;
	content: Block[];
	summary?: string;
}

/** A point of a briefing as it is shown, with the id replies name it by. */
model Point {
	/** `3` for the third point of the briefing, `3.1` for the first beneath it. */
	id: string;

	...BriefingPoint;
}

/** A list of a briefing's points as it is shown. */
model BriefingPromptSection {
	title?: string;
	points: Point[];
}

/** A briefing as it is shown to the person, before any sub-points the agent adds while answering. */
model BriefingPrompt {
	title: string;
	summary?: string;
	sections: BriefingPromptSection[];
}

/** Someone a deployment's gate recognised: a person, or the agent they authorised. */
model Actor {
	/** Stable within the deployment, as its gate names them. */
	id: string;

	/** How to show them, when the gate knows. */
	name?: string;
}

/** A reply the person gave. */
model HumanEntry {
	author: "human";
	reply: Reply;

	/** Who replied, when the deployment knows. */
	by?: Actor;

	at: utcDateTime;
}

/** An answer the agent gave: to a question asked back, or on one point of a briefing. */
model AgentEntry {
	author: "agent";
	answer: string;
	content?: Block[];

	/** The briefing point this answers. */
	point?: string;

	/** Sub-points the answer broke the point into, with their ids. */
	points?: Point[];

	at: utcDateTime;
}

/** One turn in an ask's thread after it was opened. */
union Entry {
	human: HumanEntry,
	agent: AgentEntry,
}

/** What every ask carries, whatever its kind. */
model AskCommon {
	id: string;
	status: AskStatus;

	/** Whether an agent is following this ask right now: waiting on its call, or polling it as a background task. */
	waiting: boolean;

	project?: string;

	/** The MCP client that asked, such as `claude-code 2.1.0`. */
	client?: string;

	/** Whose agent asked: the person its credential belongs to, when the deployment knows. */
	raisedBy?: Actor;

	/** Every turn after the ask was opened, oldest first. */
	thread: Entry[];

	createdAt: utcDateTime;
	updatedAt: utcDateTime;
	closedAt?: utcDateTime;
}

/** A question an agent asked. */
model QuestionAsk {
	kind: "question";
	prompt: QuestionPrompt;
	...AskCommon;
}

/** Work an agent put up for review. */
model ReviewAsk {
	kind: "review";
	prompt: ReviewPrompt;

	/** The id of the review this one revises. */
	revises?: string;

	...AskCommon;
}

/** Points an agent explained, for the person to reply on one at a time. */
model BriefingAsk {
	kind: "briefing";
	prompt: BriefingPrompt;
	...AskCommon;
}

/** Something an agent needs from a person: a short thread that ends with a reply. */
union Ask {
	question: QuestionAsk,
	review: ReviewAsk,
	briefing: BriefingAsk,
}

/** What a blocking MCP tool returns: the reply that ended its wait. */
model ToolReply {
	askId: string;
	reply: Reply;
}

/**
 * What a call that waits for the person answers: their reply and what it means for you, or, once the
 * call has waited as long as it may, that no reply has come yet.
 */
@added(Revisions.r2)
model AgentReply {
	askId: string;

	/** The reply that ended the wait, or `null` when the call stopped waiting first. */
	reply: Reply | null;

	/**
	 * What it means for you, in words: what the person said and what to do next, or how to keep
	 * waiting.
	 */
	message: string;
}

/** Open asks, newest first, and the most recently closed. */
model Snapshot {
	open: Ask[];
	recent: Ask[];
}

/** A page of closed asks, newest first. */
model AskPage {
	items: Ask[];

	/** Pass as `before` for the next page. Absent on the last page. */
	nextBefore?: utcDateTime;
}

/**
 * A one-time pass onto the event socket, for a client that cannot send headers there, as a browser
 * cannot. Offer it as the subprotocol `loopback.ticket.<ticket>` alongside `loopback.v1`. It works
 * once, within a minute, so a copy that turns up in a log is of no use to anyone.
 */
model EventTicket {
	ticket: string;
	expiresAt: utcDateTime;
}

/** Who the caller is. */
model Whoami {
	space: string;
	actor: Actor;
}

/** A stored upload. */
model UploadReceipt {
	uploadId: string;
	contentType: ImageType;
	size: int32;
}

// --- event socket frames --------------------------------------------------------------------------

/** The first frame on the event socket, and the state to start from. */
model SnapshotEvent {
	type: "snapshot";
	snapshot: Snapshot;
}

/** An ask was opened, or changed: a new turn, a close, or an agent starting or stopping following it. */
model AskEvent {
	type: "ask.opened" | "ask.updated";
	ask: Ask;
}

/** A frame on the event socket. */
union ServerEvent {
	snapshot: SnapshotEvent,
	ask: AskEvent,
}

// --- errors ---------------------------------------------------------------------------------------

/** Why a request was refused. */
model Problem {
	/** A stable, machine-readable reason, such as `ask.closed`. */
	code: string;

	message: string;
}

@error
model Unauthorized {
	@statusCode statusCode: 401;
	@body body: Problem;
}

@error
model NotFound {
	@statusCode statusCode: 404;
	@body body: Problem;
}

@error
model Conflict {
	@statusCode statusCode: 409;
	@body body: Problem;
}

@error
model Gone {
	@statusCode statusCode: 410;
	@body body: Problem;
}

@error
model TooLarge {
	@statusCode statusCode: 413;
	@body body: Problem;
}

@error
model Unprocessable {
	@statusCode statusCode: 422;
	@body body: Problem;
}

// --- operations -----------------------------------------------------------------------------------

@route("/whoami")
@useAuth(BearerAuth)
interface Session {
	/** The space the credentials open. */
	@get whoami(): Whoami | Unauthorized;
}

@route("/events/tickets")
@useAuth(BearerAuth)
interface EventTickets {
	/** A one-time pass onto the event socket, `/api/v1/events`. */
	@post issue(): {
		@statusCode statusCode: 201;
		@body body: EventTicket;
	} | Unauthorized;
}

@route("/snapshot")
@useAuth(BearerAuth)
interface Snapshots {
	/** Every open ask and the fifty most recently closed: what an inbox starts from. */
	@get read(): Snapshot | Unauthorized;
}

@route("/asks")
@useAuth(BearerAuth)
interface Asks {
	/** Closed asks, newest first, for paging back through history. */
	@get list(
		/** Only asks closed before this moment. */
		@query before?: utcDateTime,

		@query @minValue(1) @maxValue(100) limit?: int32,
	): AskPage | Unauthorized;

	@get read(@path id: string): Ask | NotFound | Unauthorized;

	/**
	 * Reply to an ask. Refused with 409 when the ask is closed or it is the agent's turn, except that
	 * a briefing may be dismissed during the agent's turn. Refused with 422 when the reply does not
	 * fit: `answered` is for questions and needs a choice or text, with choices among those offered
	 * and only one unless several are allowed; `approved` and `changes_requested` are for reviews;
	 * `responded` is for briefings, names each of their points at most once with words or resolved,
	 * and either resolves every point or leaves the agent a point to answer. A briefing takes no
	 * `follow_up`.
	 */
	@route("/{id}/reply")
	@post
	reply(@path id: string, @body reply: Reply): Ask | NotFound | Conflict | Unprocessable | Unauthorized;
}

@route("/files")
@useAuth(BearerAuth)
interface Files {
	/** An uploaded image. */
	@get read(@path uploadId: string): {
		@header contentType: ImageType;
		@body body: bytes;
	} | NotFound | Unauthorized;
}

@route("/uploads")
@useAuth(NoAuth)
interface Uploads {
	/**
	 * Store an image against an upload ticket. The URL is the credential: it works once, for
	 * fifteen minutes, for the declared content type, up to the ticket's `maxBytes`.
	 */
	@put store(
		@path spaceId: string,
		@path token: string,
		@header contentType: string,
		@body body: bytes,
	): {
		@statusCode statusCode: 201;
		@body body: UploadReceipt;
	} | NotFound | Gone | TooLarge | Unprocessable;
}

/**
 * What an agent does: put something in front of the person and wait for their reply, answer what
 * they asked back, upload an image to show them, and find their inbox. Each operation is also an MCP
 * tool, named by its operation id, with its summary as the title and its description word for word.
 *
 * A call that waits answers with the reply once the person gives it. One that has waited as long as
 * it may answers with no reply yet, and calling it again with the same arguments rejoins the same ask.
 */
@added(Revisions.r2)
@tag("Agent")
@route("/agent")
@useAuth(BearerAuth)
interface Agent {
	@summary("Ask the person a question")
	@doc("Ask the person you are working for a question. Use it whenever you need a decision, a preference or information only they have, instead of guessing, asking in your reply, or using a built-in question prompt: they answer everything from their Loopback inbox. Offer two to six choices when there are clear ones; they can always answer in their own words, ask you something back, or dismiss it. Their reply can take minutes: where your client supports background tasks this returns at once and the reply reaches you when it comes; otherwise it waits.")
	@operationId("ask_question")
	@route("/questions")
	@put
	askQuestion(@body question: QuestionInput): AgentReply | Unprocessable | Unauthorized;

	@summary("Show the person work for review")
	@doc("Show the person something you made and wait for their verdict: copy, a plan, code, a diff or a screenshot. Use it when they say \"show me\", \"let me see\" or \"run it by me\", and before you finalise anything they should sign off. Put the work itself in content, not a description of it. They can approve (perhaps with a note), request changes, ask you a question first, or dismiss it. For an image, call create_image_upload first. Returns at once as a background task where your client supports it; otherwise waits for their verdict.")
	@operationId("request_review")
	@route("/reviews")
	@put
	requestReview(@body review: ReviewInput): AgentReply | Unprocessable | Unauthorized;

	@summary("Answer the person's question")
	@doc("Answer a question the person asked back about one of your asks (a reply whose outcome is follow_up), then get their decision the same way the ask itself brings it. Include content when the answer involves something new to look at.")
	@operationId("answer_follow_up")
	@route("/follow-ups")
	@put
	answerFollowUp(
		@body answer: FollowUpInput,
	): AgentReply | NotFound | Conflict | Unprocessable | Unauthorized;

	@summary("Brief the person, point by point")
	@doc("Explain something that breaks into several points (findings, options, steps, a list of changes) so the person can reply on each point on its own: ask about one, push back on another, resolve the rest. Use it when they ask you to explain or walk them through something, instead of writing the list in your reply. Give each point a one-line title, which they see folded, and its detail beneath. Points are numbered for you, 1, 2, 3 and on, straight through every section, and their replies come back keyed to those numbers: answer them with answer_briefing. Returns at once as a background task where your client supports it; otherwise waits for their replies.")
	@operationId("send_briefing")
	@route("/briefings")
	@put
	sendBriefing(@body briefing: BriefingInput): AgentReply | Unprocessable | Unauthorized;

	@summary("Answer the person, point by point")
	@doc("Answer the person's replies on a briefing: one answer for every point they wrote on without resolving it, and for any other open point you have more to say on. When a point needs drilling into, break it into sub-points, numbered beneath it (3.1, 3.2), which they can reply on in turn. Then get their next replies the same way the briefing brought these. The briefing closes once they resolve every point.")
	@operationId("answer_briefing")
	@route("/briefing-answers")
	@put
	answerBriefing(
		@body answers: BriefingAnswerInput,
	): AgentReply | NotFound | Conflict | Unprocessable | Unauthorized;

	@summary("Open the person's inbox")
	@doc("Get the address of the person's Loopback inbox: the live page where they read and answer everything agents ask, across all their projects. Use it when they ask where their inbox or dashboard is, or to point them at one ask by its askId. Open the address for them with the system's open command if you can; otherwise give it to them.")
	@operationId("open_inbox")
	@route("/inbox")
	@get
	openInbox(
		/** An ask to open directly. Leave it out for the inbox itself. */
		@query askId?: string,
	): InboxLink | Unauthorized;

	@summary("Upload an image for a review")
	@doc("Get a one-time URL for uploading an image, such as a screenshot, to show in request_review. Run the command it returns with the file's path, then put the uploadId in an image block. The URL expires after fifteen minutes.")
	@operationId("create_image_upload")
	@route("/uploads")
	@post
	createImageUpload(@body request: UploadRequest): {
		@statusCode statusCode: 201;
		@body body: UploadTicket;
	} | Unauthorized;
}
