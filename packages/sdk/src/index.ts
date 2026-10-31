// What a frontend reads, as the SDK decodes it: each union a release can grow has an `unknown` member.
export type * from "@loopbackhq/protocol/schema";
// What a frontend sends with a reply.
export type { Reply as ReplyBody } from "@loopbackhq/protocol";
export type { BriefingTree, PointNode, PointState, PointTurn } from "@loopbackhq/protocol";
export {
	answerEntries,
	answersProblem,
	findPoint,
	foldBriefing,
	hasWords,
	MAX_POINT_DEPTH,
	MAX_TOP_POINTS,
	numberBriefing,
	respondedProblem,
} from "@loopbackhq/protocol";
export {
	ApiError,
	EVENTS_PROTOCOL,
	LoopbackClient,
	type LoopbackApi,
	type LoopbackConfig,
	make,
	TICKET_PROTOCOL_PREFIX,
} from "./client.ts";
export {
	applyEvent,
	awaitingHuman,
	type InboxEvent,
	type InboxState,
	initialInbox,
	RECENT_LIMIT,
} from "./inbox.ts";
export { createLoopbackClient, type InboxStore, type LoopbackPromiseClient } from "./promise.ts";
