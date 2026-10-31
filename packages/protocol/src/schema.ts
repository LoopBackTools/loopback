/**
 * The contract as a reader decodes it: Effect schemas for every message at the latest revision,
 * generated from the spec. Each union a release can grow (kinds of ask, blocks of content, reply
 * outcomes, socket frames) has an `unknown` member, so a reader that meets a message from a newer
 * revision keeps what it can show instead of failing. Decode what you receive with these; never cast
 * it. See docs/design/versioned-messages.md.
 */
export * from "./generated/schemas.gen.ts";
export type { UnknownAsk, UnknownBlock, UnknownEvent, UnknownReply } from "./unknown.ts";
