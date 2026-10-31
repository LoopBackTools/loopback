import { Schema, SchemaGetter } from "effect";

/**
 * What a reader makes of a message it can't read: one of a kind, outcome or type it doesn't know, as
 * it meets one from a newer revision of the contract. It keeps what it can still show and what the
 * message said it was, so that one message is drawn as "can't be shown" instead of failing
 * everything around it. The generated schemas end each union a release can grow with one of these
 * (`scripts/schemas.ts`). See docs/design/versioned-messages.md.
 */

/** An ask of a kind this reader doesn't know, or that it can't otherwise read. */
export interface UnknownAsk<Status extends string = string> {
	readonly kind: "unknown";
	/** The kind it said it was. */
	readonly was: string;
	readonly id: string;
	/** Its status, or `closed` when that is unknown too, so it never asks for attention it can't get. */
	readonly status: Status;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly project?: string;
}

/** The fields every ask has had in every revision, which is all an unknown ask is read for. */
const AskFields = Schema.Struct({
	kind: Schema.String,
	id: Schema.String,
	status: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	project: Schema.optionalKey(Schema.String),
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
				createdAt: Schema.String,
				updatedAt: Schema.String,
				project: Schema.optionalKey(Schema.String),
			}),
			{
				decode: SchemaGetter.transform(({ kind, status, ...rest }) => ({
					...rest,
					kind: "unknown" as const,
					was: kind,
					status: known(status) ? status : ("closed" as Status),
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
