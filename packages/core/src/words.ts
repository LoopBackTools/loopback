import {
	type BriefingAsk,
	findPoint,
	foldBriefing,
	type Responded,
	type ToolReply,
} from "@loopbacktools/protocol";

/**
 * What agents are told, in the words they already know. Every edge passes these on as they are,
 * so an agent hears the same thing through any of them.
 */

/** The tools an agent waits through, named in what it is told to call next. */
export type Tool =
	| "ask_question"
	| "request_review"
	| "send_briefing"
	| "answer_follow_up"
	| "answer_briefing";

/** What a background task says while it waits. */
export const WAITING_FOR_THE_PERSON = "Waiting for the person to reply in Loopback.";

/**
 * What a blocking call that waited its whole budget answers: no reply yet, and how to keep waiting.
 * Calling the same tool again with the same arguments rejoins the ask.
 */
export const noReplyYet = (tool: Tool): string =>
	`No reply yet. Call ${tool} again with the same arguments to keep waiting; it rejoins this ask.`;

/** "2", "2 and 3", "1, 2 and 3". */
const listed = (items: readonly string[]): string =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** A briefing, and where in its thread a reply landed. */
export interface Landed {
	readonly briefing: BriefingAsk;
	readonly seq: number;
}

/**
 * Replies on a briefing, each point named with its title, and what the agent owes now. The briefing
 * is read as it stood when this reply landed, so a task polled again later says the same.
 */
const describeResponded = (askId: string, reply: Responded, landed?: Landed): string => {
	const tree =
		landed === undefined
			? undefined
			: foldBriefing(landed.briefing.prompt, landed.briefing.thread.slice(0, landed.seq));
	const named = (id: string) => {
		const title = tree === undefined ? undefined : findPoint(tree, id)?.title;
		return title === undefined ? id : `${id} (${title})`;
	};
	const lines = reply.points.map((item) => {
		const wrote = item.text?.trim() ?? "";
		// As the fold reads it: words on or beneath a point resolved in the same reply are closing
		// notes, and its record of this turn on the point says so.
		const turn = tree === undefined ? undefined : findPoint(tree, item.point)?.turns.at(-1);
		const settled = turn?.author === "human" ? turn.resolved : item.resolved === true;
		const said = settled
			? wrote === ""
				? "resolved."
				: `resolved, saying "${wrote}"`
			: `they wrote "${wrote}"`;
		return `- Point ${named(item.point)}: ${said}`;
	});
	const next =
		tree === undefined || tree.resolved
			? "The briefing is closed: every point is resolved. Act on what they said, or ask a new question if something is still unclear."
			: `Answer ${tree.owed.length === 1 ? "point" : "points"} ${listed(tree.owed.map(named))} with answer_briefing (askId: "${askId}"): each is owed an answer. You may answer other open points too, and break any point into sub-points.`;
	return ["The person replied on the briefing:", ...lines, "", next].join("\n");
};

/** What a reply means for the agent, said plainly. A briefing's replies name its points' titles. */
export const describe = ({ askId, reply }: ToolReply, landed?: Landed): string => {
	switch (reply.outcome) {
		case "answered": {
			const chose =
				reply.selected.length === 0
					? ""
					: `They chose: ${reply.selected.map((label) => `"${label}"`).join(", ")}.`;
			const wrote =
				reply.text === undefined || reply.text.trim() === "" ? "" : `They wrote: ${reply.text}`;
			return ["The person answered.", chose, wrote].filter((part) => part !== "").join(" ");
		}
		case "approved":
			return reply.note === undefined ? "Approved." : `Approved, with a note: ${reply.note}`;
		case "changes_requested":
			return `Changes requested: ${reply.feedback}\n\nRevise the work, then call request_review again with revises: "${askId}".`;
		case "follow_up":
			return `The person asked a question before deciding: ${reply.question}\n\nAnswer it with answer_follow_up (askId: "${askId}"). This ask stays open, and that call returns their decision.`;
		case "dismissed":
			return "The person dismissed this without answering. Carry on with your best judgement, or ask differently.";
		case "responded":
			return describeResponded(askId, reply, landed);
	}
};
