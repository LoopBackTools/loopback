import * as Contract from "@loopbacktools/protocol/schema";
import { Effect, Result, Schema } from "effect";
import type { Operations } from "./operations.ts";
import { read } from "./read.ts";

/**
 * What each space operation takes, as the space decodes it before running anything: the contract's
 * messages with the schemas generated from it, and the ids and numbers beside them. Nothing a call
 * passes is run unread. See docs/design/versioned-messages.md.
 */

const Id = Schema.String;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const opening = <const Kind extends string, Input extends Schema.Top>(kind: Kind, input: Input) =>
	Schema.Struct({
		kind: Schema.Literal(kind),
		input,
		client: Schema.optionalKey(Schema.String),
		actor: Contract.Actor,
	});

const OpenRequest = Schema.Union([
	opening("question", Contract.QuestionInput),
	opening("review", Contract.ReviewInput),
	opening("briefing", Contract.BriefingInput),
]);

const taking = {
	open: Schema.Tuple([OpenRequest]),
	answerFollowUp: Schema.Tuple([Contract.FollowUpInput]),
	answerBriefing: Schema.Tuple([Contract.BriefingAnswerInput]),
	takeReply: Schema.Tuple([Id, Count]),
	markDelivered: Schema.Tuple([Id, Count]),
	// Code from before deployments set their own poll intervals sends only the ask and the turn.
	// Code from before deployments set their own poll intervals sends only the ask and the turn.
	followTask: Schema.Tuple([Id, Count, Schema.optional(Schema.Tuple([Count, Count, Count]))]),
	cancelTask: Schema.Tuple([Id, Count]),
	reply: Schema.Tuple([Id, Contract.Reply, Contract.Actor]),
	get: Schema.Tuple([Id]),
	snapshot: Schema.Tuple([]),
	history: Schema.Tuple([Schema.UndefinedOr(Schema.String), Count]),
	createUpload: Schema.Tuple([Contract.ImageType]),
	claimUpload: Schema.Tuple([Schema.String, Schema.String]),
	completeUpload: Schema.Tuple([Id, Count]),
	findUpload: Schema.Tuple([Id]),
	issueTicket: Schema.Tuple([Id]),
	redeemTicket: Schema.Tuple([Schema.String]),
};

/** Each operation whose schema refuses something the operation itself accepts. */
type Narrower = {
	readonly [K in keyof Operations]: Parameters<Operations[K]> extends (typeof taking)[K]["Type"]
		? never
		: K;
}[keyof Operations];

/** The compiler's check that every operation has a schema, and that none refuses what it accepts. */
const everyOperationRead: [Narrower] extends [never] ? true : Narrower = true;
void everyOperationRead;

/**
 * A call's arguments, decoded for its operation. Arguments that don't decode, or that hold something
 * from a newer revision, are a fault in the caller: the operation never runs on them, and nothing is
 * kept. A caller on a newer revision is refused as `Outdated` before this.
 */
export const readArguments = <K extends keyof Operations>(
	method: K,
	args: readonly unknown[],
): Effect.Effect<Parameters<Operations[K]>> =>
	Result.match(read(taking[method] as Schema.Codec<unknown, unknown>, args), {
		onSuccess: (decoded) => Effect.succeed(decoded as Parameters<Operations[K]>),
		onFailure: (why) => Effect.die(new Error(`Space.${method} can't read its arguments: ${why}`)),
	});
