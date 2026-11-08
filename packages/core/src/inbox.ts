import type { Problem, Reply } from "@loopbacktools/protocol";
import { Effect, Option } from "effect";
import { fileKey, Files } from "./files.ts";
import type { Answer, Caller, FileAnswer, Refusal } from "./rpc.ts";
import { UPLOAD_MAX_BYTES } from "./space/operations.ts";
import { Spaces } from "./spaces.ts";

/**
 * The inbox's operations, each answering with a response the contract declares: every error a space
 * operation fails with becomes its status and problem here, once, for every edge.
 */

export const problem = (code: string, message: string): Problem => ({ code, message });

/** How many closed asks a history page holds when the caller does not say. */
const DEFAULT_PAGE = 20;

const answer = <Status extends number, Body>(status: Status, body: Body): Answer<Status, Body> => ({
	status,
	body,
});

const refusal = <Status extends number>(
	status: Status,
	code: string,
	message: string,
): Refusal<Status> => answer(status, problem(code, message));

const notFound = (message: string) => Effect.succeed(refusal(404, "not_found", message));

const spaceOf = (caller: Caller) =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		return spaces.of(caller.space);
	});

export const whoami = (caller: Caller) =>
	Effect.succeed(answer(200, { space: caller.space, actor: caller.actor }));

export const issueTicket = (caller: Caller) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		const issued = yield* space.issueTicket(caller.actor.id);
		return answer(201, {
			ticket: `${issued.spaceId}.${issued.secret}`,
			expiresAt: issued.expiresAt,
		});
	});

export const snapshot = (caller: Caller) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		return answer(200, yield* space.snapshot());
	});

export const history = (caller: Caller, before: string | undefined, limit: number | undefined) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		return answer(200, yield* space.history(before, limit ?? DEFAULT_PAGE));
	});

export const read = (caller: Caller, id: string) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		return answer(200, yield* space.get(id));
	}).pipe(Effect.catchTag("AskNotFound", () => notFound(`No ask ${id}.`)));

export const reply = (caller: Caller, id: string, given: Reply) =>
	Effect.gen(function* () {
		const space = yield* spaceOf(caller);
		return answer(200, yield* space.reply(id, given, caller.actor));
	}).pipe(
		Effect.catchTags({
			AskNotFound: () => notFound(`No ask ${id}.`),
			AskClosed: () =>
				Effect.succeed(refusal(409, "ask.closed", "This ask has already been answered.")),
			NotYourTurn: () =>
				Effect.succeed(
					refusal(409, "ask.agent_turn", "The agent owes an answer before you can reply."),
				),
			ReplyInvalid: (error) => Effect.succeed(refusal(422, "reply.invalid", error.reason)),
		}),
	);

export const readFile = (caller: Caller, uploadId: string) =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		const files = yield* Files;
		const upload = yield* spaces.of(caller.space).findUpload(uploadId);
		const body = yield* files.get(fileKey(spaces.idOf(caller.space), uploadId));
		if (Option.isNone(body)) return yield* notFound(`No file ${uploadId}.`);
		const found: FileAnswer = { status: 200, contentType: upload.contentType, body: body.value };
		return found;
	}).pipe(Effect.catchTag("UploadNotFound", () => notFound(`No file ${uploadId}.`)));

const tooLarge = (maxBytes: number) =>
	refusal(413, "upload.too_large", `Images may be up to ${maxBytes} bytes.`);

/**
 * Stores an image against an upload ticket. The space is named by its object id, as the upload URL
 * does, and an id this core did not mint is no upload. A body refused before it is read is let go,
 * so the stream the edge is sending it from ends instead of hanging.
 */
export const storeUpload = (input: {
	readonly spaceId: string;
	readonly token: string;
	readonly contentType: string;
	readonly length: number;
	readonly body: ReadableStream<Uint8Array> | null;
}) =>
	Effect.suspend(() => {
		const { length, body } = input;
		let handed = false;
		const release = Effect.suspend(() =>
			handed || body === null ? Effect.void : Effect.promise(() => body.cancel().catch(() => {})),
		);
		return Effect.gen(function* () {
			const spaces = yield* Spaces;
			const files = yield* Files;
			const space = spaces.byId(input.spaceId);
			if (Option.isNone(space)) return yield* notFound("No such upload.");
			if (!Number.isSafeInteger(length) || length <= 0 || body === null) {
				return refusal(422, "upload.length_required", "Send the image with a Content-Length.");
			}
			// Refused before the ticket is claimed, so it stays good for an image that fits.
			if (length > UPLOAD_MAX_BYTES) return tooLarge(UPLOAD_MAX_BYTES);
			const claimed = yield* space.value.claimUpload(input.token, input.contentType);
			if (length > claimed.maxBytes) return tooLarge(claimed.maxBytes);
			handed = true;
			yield* files.put(fileKey(input.spaceId, claimed.uploadId), body, length, claimed.contentType);
			return answer(201, yield* space.value.completeUpload(claimed.uploadId, length));
		}).pipe(Effect.ensuring(release));
	}).pipe(
		Effect.catchTags({
			UploadNotFound: () => notFound("No such upload."),
			UploadExpired: () =>
				Effect.succeed(
					refusal(410, "upload.expired", "This upload URL has expired or was already used."),
				),
			UploadRejected: (error) => Effect.succeed(refusal(422, "upload.rejected", error.reason)),
			UploadIncomplete: () =>
				Effect.succeed(
					refusal(
						422,
						"upload.incomplete",
						"The image ended before, or ran past, its Content-Length.",
					),
				),
		}),
	);

/** Where an inbox's socket upgrade names its space, by object id, with its ticket in the query. */
const EVENTS_PATH = /^\/spaces\/id\/([^/]+)\/events$/;

const refused = (status: number, code: string, message: string) =>
	Response.json(problem(code, message), { status });

/**
 * Hands an inbox's WebSocket upgrade to its space once its one-time ticket is spent, which the
 * space answers with itself as it stands. Nothing else reaches a space from outside.
 */
export const connect = (request: Request) =>
	Effect.gen(function* () {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return refused(426, "events.upgrade_required", "Connect with a WebSocket.");
		}
		const url = new URL(request.url);
		const spaceId = EVENTS_PATH.exec(url.pathname)?.[1];
		if (spaceId === undefined) return refused(404, "not_found", "No such route.");
		const spaces = yield* Spaces;
		const space = spaces.byId(spaceId);
		const secret = url.searchParams.get("ticket");
		if (Option.isNone(space) || secret === null) {
			return refused(401, "auth.unauthorized", "The event ticket is not valid.");
		}
		yield* space.value.redeemTicket(secret);
		return yield* spaces.connect(spaceId, request);
	}).pipe(
		Effect.catchTag("TicketInvalid", () =>
			Effect.succeed(
				refused(401, "auth.unauthorized", "The event ticket is not valid, or was already used."),
			),
		),
	);

/** Deletes everything a space holds, files included. Running it again finishes what a failed run left. */
export const erase = (space: string) =>
	Effect.gen(function* () {
		const spaces = yield* Spaces;
		const files = yield* Files;
		yield* spaces.erase(space);
		yield* files.erase(spaces.idOf(space));
	});
