import { Data, Effect, type Exit, Schedule, Schema } from "effect";
import {
	AskClosed,
	AskNotFound,
	ContentInvalid,
	NotYourTurn,
	ReplyInvalid,
	TicketInvalid,
	UploadExpired,
	UploadNotFound,
	UploadRejected,
} from "../domain/errors.ts";
import { type Operations, operations } from "./operations.ts";

/**
 * The version of the code making a call: the contract revision it writes, and the deploy it is part
 * of. A space compares them with its own, since for a while after a deploy the Worker and a space can
 * run different code. `build` is the version's creation time, from Cloudflare's version metadata, and
 * absent where there is none (local tests): then nothing is compared.
 */
export interface Caller {
	readonly revision: number;
	readonly build?: string | undefined;
}

/**
 * The one frame a space sends an agent's wait socket (`/wait/<askId>`): a reply landed on the ask,
 * for the agent to take with `takeReply`. Anything else a wait socket hears is the auto-response to
 * its pings.
 */
export const REPLY_FRAME = "reply";

/** Where a Worker opens an agent's wait for the reply to its turn `afterSeq` of an ask. */
export const waitPath = (askId: string, afterSeq: number) =>
	`/wait/${encodeURIComponent(askId)}/${afterSeq}`;

/** A deployment's build, from its version metadata binding, if it has one. */
export const buildOf = (env: unknown): string | undefined => {
	const metadata = (env as { readonly CF_VERSION_METADATA?: { readonly timestamp?: unknown } })
		.CF_VERSION_METADATA;
	return typeof metadata?.timestamp === "string" ? metadata.timestamp : undefined;
};

/** Whether a build is from a later deploy than another; unknown when either is. */
export const isLater = (build: string | undefined, than: string | undefined): boolean =>
	build !== undefined && than !== undefined && Date.parse(build) > Date.parse(than);

/**
 * A space's refusal of a call from newer code than its own: it ran nothing, and restarts onto the new
 * code a moment later. The client tries the call again, whatever it is, and never hands this on.
 */
export class Outdated extends Schema.TaggedError<Outdated>()("Outdated", {}) {}

/** Every error a space operation fails with. */
export const SpaceFailure = Schema.Union([
	AskNotFound,
	AskClosed,
	NotYourTurn,
	ReplyInvalid,
	ContentInvalid,
	TicketInvalid,
	UploadNotFound,
	UploadExpired,
	UploadRejected,
]);
export type SpaceFailure = typeof SpaceFailure.Type;

/**
 * An operation's outcome as it crosses the RPC boundary. Errors do not survive structured clone
 * with their tags, so every answer is its Exit encoded as JSON; a defect crosses as its name and
 * message. Success values are the contract's own JSON shapes and pass through unchanged.
 */
export type ExitJson = Schema.Json;

/** What a call can fail with across the boundary: an operation's errors, or the space's refusal. */
const CallFailure = Schema.Union([...SpaceFailure.members, Outdated]);
type CallFailure = typeof CallFailure.Type;

// A defect keeps its stack across the hop, so it is logged where it happened: this codec only ever
// runs between the Worker and its own Durable Object, never towards a client.
let codec: Schema.Codec<Exit.Exit<Schema.Json, CallFailure>, Schema.Json> | undefined;
const exitCodec = () =>
	(codec ??= Schema.toCodecJson(
		Schema.Exit(Schema.Json, CallFailure, Schema.Defect({ includeStack: true })),
	));

export const encodeExit = (exit: Exit.Exit<unknown, CallFailure>): ExitJson =>
	Schema.encodeSync(exitCodec())(exit as Exit.Exit<Schema.Json, CallFailure>);

const decodeExit = (json: unknown) => Schema.decodeUnknownSync(exitCodec())(json);

/** A space operation by name, as the object serves it. */
export type OperationName = keyof Operations;

/** What the Worker holds to reach a space: its object's single RPC entry point. */
export interface SpaceStub {
	call(method: OperationName, args: readonly unknown[], caller: Caller): Promise<ExitJson>;
}

/** A space's operations as seen from the core Worker: the same signatures, with no services required. */
export type SpaceClient = {
	readonly [K in OperationName]: (
		...args: Parameters<Operations[K]>
	) => Effect.Effect<
		Effect.Success<ReturnType<Operations[K]>>,
		Effect.Error<ReturnType<Operations[K]>>
	>;
};

/**
 * Operations that are safe to run twice: reads, and writes that leave the space as the first run
 * did. Only these are retried. A reply, an upload ticket, or an upload claim is not: a second run
 * is refused, or issues another.
 */
const idempotent: ReadonlySet<OperationName> = new Set<OperationName>([
	"open",
	"answerFollowUp",
	"answerBriefing",
	"takeReply",
	"markDelivered",
	"followTask",
	"cancelTask",
	"get",
	"snapshot",
	"history",
	"findUpload",
]);

/** A call the object never answered: it was reset (by a deploy, say), or the transport failed. */
class Refused extends Data.TaggedError("Refused")<{ readonly cause: unknown }> {
	/** Whether Cloudflare marks it safe to try again: retryable, and not because the object is overloaded. */
	get retryable(): boolean {
		const flags = this.cause as { readonly retryable?: unknown; readonly overloaded?: unknown };
		return flags?.retryable === true && flags.overloaded !== true;
	}
}

/** A deploy resets every space; its new instance is up within moments. */
const RETRY = {
	schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
	times: 5,
	while: (refused: Refused) => refused.retryable,
};

/**
 * A space restarting onto new code takes a moment, and refuses as `Outdated` until it has; the
 * retries outlast that.
 */
const OUTDATED_RETRY = {
	schedule: Schedule.exponential("50 millis").pipe(Schedule.jittered),
	times: 6,
	while: (failure: unknown) => failure instanceof Outdated,
};

/**
 * The typed client for one space, for code of the version `caller` names. Each call is decoded back
 * into the operation's own success value or tagged error. A call the object refused is tried again on
 * a fresh stub when it is safe to, as Cloudflare advises; otherwise it is a defect. A call a space
 * refused as `Outdated` ran nothing, so it is tried again whatever it is, until the space is on the
 * new code.
 */
export const spaceClient = (stub: () => SpaceStub, caller: Caller): SpaceClient =>
	Object.fromEntries(
		(Object.keys(operations) as OperationName[]).map((method) => {
			const once = (args: readonly unknown[]) =>
				Effect.tryPromise({
					try: () => stub().call(method, args, caller),
					catch: (cause) => new Refused({ cause }),
				});
			const attempt = (args: readonly unknown[]) =>
				(idempotent.has(method) ? Effect.retry(once(args), RETRY) : once(args)).pipe(
					Effect.catchTag("Refused", (refused) => Effect.die(refused.cause)),
					Effect.flatMap((json) => decodeExit(json)),
				);
			return [
				method,
				(...args: unknown[]) =>
					attempt(args).pipe(
						Effect.retry(OUTDATED_RETRY),
						Effect.catchIf(
							(failure) => failure instanceof Outdated,
							() => Effect.die(new Error("The space did not move onto this code in time.")),
						),
					),
			];
		}),
	) as unknown as SpaceClient;
