import { Schema, SchemaGetter } from "effect";

/**
 * What a reader makes of a message it can't read: one of a kind, outcome or type it doesn't know, as
 * it meets one from a newer revision of the contract. It keeps what it can still show and what the
 * message said it was, so that one message is drawn as "can't be shown" instead of failing
 * everything around it. The generated schemas end each union a release can grow with one of these
 * (`scripts/schemas.ts`). See docs/design/versioned-messages.md.
 */

/** Who an unknown ask was raised by, read as leniently as the rest of it. */
interface UnknownActor {
	readonly id: string;
	readonly name?: string;
}

/** An ask of a kind this reader doesn't know, or that it can't otherwise read. */
export interface UnknownAsk<Status extends string = string> {
	readonly kind: "unknown";
	/** The kind it said it was. */
	readonly was: string;
	readonly id: string;
	/** Its status, or `closed` when that is unknown too, so it never asks for attention it can't get. */
	readonly status: Status;
	readonly waiting: boolean;
	readonly project?: string;
	readonly client?: string;
	readonly raisedBy?: UnknownActor;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt?: string;
}

const Actor = Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) });

/**
 * What an unknown ask is read for: what every ask has had in every revision, which a list of asks
 * shows and sorts by. Only the identity, status and times are required, so an ask from a newer
 * revision that has dropped anything else still reads as one.
 */
const AskFields = Schema.Struct({
	kind: Schema.String,
	id: Schema.String,
	status: Schema.String,
	waiting: Schema.optionalKey(Schema.Boolean),
	project: Schema.optionalKey(Schema.String),
	client: Schema.optionalKey(Schema.String),
	raisedBy: Schema.optionalKey(Actor),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	closedAt: Schema.optionalKey(Schema.String),
});

/** The union member for an ask this reader can't read, given the statuses it knows. */
export const unknownAsk = <Status extends string>(statuses: Schema.Codec<Status>) => {
	const known = Schema.is(statuses);
	return AskFields.pipe(
		Schema.decodeTo(
			Schema.Struct({
				kind: Schema.Literal("unknown"),
				was: Schema.String,
				id: Schema.String,
				status: statuses,
				waiting: Schema.Boolean,
				project: Schema.optionalKey(Schema.String),
				client: Schema.optionalKey(Schema.String),
				raisedBy: Schema.optionalKey(Actor),
				createdAt: Schema.String,
				updatedAt: Schema.String,
				closedAt: Schema.optionalKey(Schema.String),
			}),
			{
				decode: SchemaGetter.transform(({ kind, status, waiting, ...rest }) => ({
					...rest,
					kind: "unknown" as const,
					was: kind,
					status: known(status) ? status : ("closed" as Status),
					waiting: waiting ?? false,
				})),
				encode: SchemaGetter.transform(({ was, ...rest }) => ({ ...rest, kind: was })),
			},
		),
	);
};

/** A message whose `type` this reader doesn't know: the type `unknown`, and what it was. */
const unknownType = Schema.Struct({ type: Schema.String }).pipe(
	Schema.decodeTo(Schema.Struct({ type: Schema.Literal("unknown"), was: Schema.String }), {
		decode: SchemaGetter.transform(({ type }) => ({ type: "unknown" as const, was: type })),
		encode: SchemaGetter.transform(({ was }) => ({ type: was })),
	}),
);

/** A block of content of a type this reader doesn't know. */
export interface UnknownBlock {
	readonly type: "unknown";
	readonly was: string;
}
export const unknownBlock = unknownType;

/** A frame on the event socket of a type this reader doesn't know. Readers skip it. */
export interface UnknownEvent {
	readonly type: "unknown";
	readonly was: string;
}
export const unknownEvent = unknownType;

/** A reply with an outcome this reader doesn't know. */
export interface UnknownReply {
	readonly outcome: "unknown";
	readonly was: string;
}
export const unknownReply = Schema.Struct({ outcome: Schema.String }).pipe(
	Schema.decodeTo(Schema.Struct({ outcome: Schema.Literal("unknown"), was: Schema.String }), {
		decode: SchemaGetter.transform(({ outcome }) => ({
			outcome: "unknown" as const,
			was: outcome,
		})),
		encode: SchemaGetter.transform(({ was }) => ({ outcome: was })),
	}),
);
