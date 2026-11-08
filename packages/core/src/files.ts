import { Context, Effect, Layer, Option } from "effect";
import { UploadIncomplete } from "./domain/errors.ts";

/** Uploaded images, kept in R2 under the space that holds them. */
export class Files extends Context.Service<
	Files,
	{
		/**
		 * Stores exactly `length` bytes from `body`. A body that turns out longer or shorter than it
		 * declared is refused by the stream itself, so the size limit holds whatever the client claims.
		 * R2 failing is a defect: nothing the client sent caused it.
		 */
		readonly put: (
			key: string,
			body: ReadableStream<Uint8Array>,
			length: number,
			contentType: string,
		) => Effect.Effect<void, UploadIncomplete>;
		readonly get: (key: string) => Effect.Effect<Option.Option<ReadableStream<Uint8Array>>>;
		/** Deletes every file a space holds. Running it again finishes what a failed run left. */
		readonly erase: (spaceId: string) => Effect.Effect<void>;
	}
>()("loopback/Files") {
	static readonly layer = (bucket: R2Bucket) =>
		Layer.succeed(
			Files,
			Files.of({
				put: (key, body, length, contentType) =>
					Effect.gen(function* () {
						const sized = new FixedLengthStream(length);
						// A wrong length fails both the pipe and R2's put, as R2 failing does, so what the
						// body itself did decides whose fault it was.
						let seen = 0;
						let ended = false;
						const counted = body.pipeThrough(
							new TransformStream<Uint8Array, Uint8Array>({
								transform: (chunk, controller) => {
									seen += chunk.byteLength;
									controller.enqueue(chunk);
								},
								flush: () => {
									ended = true;
								},
							}),
						);
						const [stored, piped] = yield* Effect.promise(() =>
							Promise.allSettled([
								bucket.put(key, sized.readable, { httpMetadata: { contentType } }),
								counted.pipeTo(sized.writable),
							]),
						);
						if (seen > length || (ended && seen !== length)) return yield* new UploadIncomplete();
						if (stored.status === "rejected") return yield* Effect.die(stored.reason);
						if (piped.status === "rejected") return yield* Effect.die(piped.reason);
					}),
				get: (key) =>
					Effect.promise(() => bucket.get(key)).pipe(
						Effect.map((object) => Option.map(Option.fromNullishOr(object), (found) => found.body)),
					),
				erase: (spaceId) => Effect.promise(() => eraseUnder(bucket, filesOf(spaceId))),
			}),
		);
}

/** Deletes every file under a prefix, a page of listings at a time. */
const eraseUnder = async (bucket: R2Bucket, prefix: string): Promise<void> => {
	const listed = await bucket.list({ prefix, limit: 1000 });
	if (listed.objects.length > 0) await bucket.delete(listed.objects.map(({ key }) => key));
	if (listed.truncated) await eraseUnder(bucket, prefix);
};

/** Where every file a space holds lives, under one prefix. */
export const filesOf = (spaceId: string) => `spaces/${spaceId}/`;

/** Where an upload's bytes live. */
export const fileKey = (spaceId: string, uploadId: string) =>
	`${filesOf(spaceId)}uploads/${uploadId}`;
