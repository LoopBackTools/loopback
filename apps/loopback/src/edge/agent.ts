import type { AskOutcome, Caller, CoreRpc, IssuedUpload, Wait } from "@loopbacktools/core/rpc";
import type { UploadTicket } from "@loopbacktools/protocol";
import type { Tools } from "../generated/mcp.gen.ts";
import { ready } from "./core.ts";

/** Where an inbox, or one ask in it, is read and answered. */
export interface InboxLink {
	readonly origin: string;
	readonly space: string;
	readonly askId?: string;
}

/** The inbox this edge serves itself, as `@loopbacktools/app` routes it: the space's, or one ask in it. */
export const inboxUrl = ({ origin, space, askId }: InboxLink): string =>
	`${origin}/w/${encodeURIComponent(space)}${askId === undefined ? "" : `/asks/${encodeURIComponent(askId)}`}`;

/** One agent call, as the surface it came through hands it on. */
export interface AgentCall {
	readonly core: CoreRpc;
	/** The edge's own origin, which the inbox and upload addresses are on. */
	readonly origin: string;
	/** The MCP client that called, such as `claude-code 2.1.0`, when it says. */
	readonly client?: string;
	/** How long the call may wait for the person, and how it tells its client it is alive. */
	readonly wait: Wait;
	/** What the surface makes of a call that failed: thrown on, or turned into what the agent is told. */
	readonly failed: (error: unknown) => never;
}

const unexpected = (outcome: AskOutcome): never => {
	throw new Error(`The core answered "${outcome.outcome}" where the edge waits for every reply.`);
};

/** What a call that waited for the person answers: their reply, or no reply yet, and what it means. */
const waited = (outcome: Extract<AskOutcome, { outcome: "replied" | "waiting" }>) =>
	({
		status: 200,
		body: {
			askId: outcome.askId,
			reply: outcome.outcome === "replied" ? outcome.reply : null,
			message: outcome.message,
		},
	}) as const;

/** An opened ask, answered as the contract declares: its content is all the space can refuse. */
const opened = (outcome: AskOutcome) => {
	switch (outcome.outcome) {
		case "replied":
		case "waiting":
			return waited(outcome);
		case "refused":
			if (outcome.status !== 422) return unexpected(outcome);
			return { status: 422, body: { code: outcome.code, message: outcome.message } } as const;
		case "started":
			return unexpected(outcome);
	}
};

/** A move on an ask that exists, answered as the contract declares. */
const moved = (outcome: AskOutcome) => {
	switch (outcome.outcome) {
		case "replied":
		case "waiting":
			return waited(outcome);
		case "refused":
			return {
				status: outcome.status,
				body: { code: outcome.code, message: outcome.message },
			} as const;
		case "started":
			return unexpected(outcome);
	}
};

/** Where to upload an image, and the command that does it. */
const ticketOf = (origin: string, issued: IssuedUpload): UploadTicket => {
	const uploadUrl = `${origin}/api/v1/uploads/${issued.spaceId}/${issued.token}`;
	return {
		uploadId: issued.uploadId,
		uploadUrl,
		expiresAt: issued.expiresAt,
		maxBytes: issued.maxBytes,
		command: `curl -sS --fail-with-body -X PUT -H 'Content-Type: ${issued.contentType}' --data-binary @FILE '${uploadUrl}'`,
	};
};

/**
 * What an agent does, through the core: the contract's agent operations, which the edge serves both
 * as MCP tools and as HTTP routes. Every call that brings a reply waits for it, as long as the call's
 * wait allows; the core does the waiting and says what each reply means.
 */
export const agentOperations = (call: AgentCall) => {
	const { core, wait } = call;
	const attempt = async <A>(work: () => Promise<A>): Promise<A> => {
		try {
			await ready(core);
			return await work();
		} catch (error) {
			return call.failed(error);
		}
	};
	return {
		ask_question: (caller: Caller, input) =>
			attempt(async () => opened(await core.askQuestion(caller, input, call.client, wait))),
		request_review: (caller: Caller, input) =>
			attempt(async () => opened(await core.requestReview(caller, input, call.client, wait))),
		send_briefing: (caller: Caller, input) =>
			attempt(async () => opened(await core.sendBriefing(caller, input, call.client, wait))),
		answer_follow_up: (caller: Caller, input) =>
			attempt(async () => moved(await core.answerFollowUp(caller, input, wait))),
		answer_briefing: (caller: Caller, input) =>
			attempt(async () => moved(await core.answerBriefing(caller, input, wait))),
		open_inbox: (caller: Caller, input) => ({
			status: 200,
			body: {
				url: inboxUrl(
					input.askId === undefined
						? { origin: call.origin, space: caller.space }
						: { origin: call.origin, space: caller.space, askId: input.askId },
				),
			},
		}),
		create_image_upload: (caller: Caller, input) =>
			attempt(async () => ({
				status: 201,
				body: ticketOf(call.origin, await core.createUpload(caller, input.contentType)),
			})),
	} satisfies Tools<Caller>;
};
