import type {
	Actor,
	AskStatus,
	BriefingPrompt,
	Entry,
	ImageType,
	QuestionPrompt,
	ReviewPrompt,
} from "@loopbacktools/protocol";
import * as Contract from "@loopbacktools/protocol/schema";
import { Context, Effect, Layer, Option, Result, type Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { AskRecord, EntryRecord } from "../domain/ask.ts";
import { read } from "./read.ts";

const { REVISION } = Contract;

interface AskRow {
	readonly id: string;
	readonly kind: string;
	readonly key: string;
	readonly status: string;
	readonly prompt: string;
	readonly project: string | null;
	readonly client: string | null;
	readonly raisedBy: string | null;
	readonly revises: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
	readonly lastWaitedAt: string | null;
	readonly followedUntil: string | null;
}

interface EntryRow {
	readonly askId: string;
	readonly seq: number;
	readonly body: string;
	readonly deliveredAt: string | null;
	readonly revision: number;
}

/** A column holding a message as JSON, decoded. */
const parsed = <A>(schema: Schema.Codec<A, unknown>, json: string): Result.Result<A, string> => {
	try {
		return read(schema, JSON.parse(json));
	} catch {
		return Result.fail("it is not JSON");
	}
};

/**
 * A stored ask as this code reads it, or why it can't: what a deploy once left half-written, say.
 * What `read` hands back holds nothing from a newer revision, so it is what this code writes.
 */
const askOf = (row: AskRow): Result.Result<AskRecord, string> =>
	Result.gen(function* () {
		const head = {
			id: row.id,
			key: row.key,
			status: (yield* read(Contract.AskStatus, row.status)) as AskStatus,
			project: row.project,
			client: row.client,
			raisedBy:
				row.raisedBy === null ? null : ((yield* parsed(Contract.Actor, row.raisedBy)) as Actor),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			closedAt: row.closedAt,
			lastWaitedAt: row.lastWaitedAt,
			followedUntil: row.followedUntil,
		};
		switch (row.kind) {
			case "question": {
				const prompt = yield* parsed(Contract.QuestionPrompt, row.prompt);
				return { ...head, kind: "question", prompt: prompt as QuestionPrompt } as const;
			}
			case "review": {
				const prompt = yield* parsed(Contract.ReviewPrompt, row.prompt);
				return {
					...head,
					kind: "review",
					prompt: prompt as ReviewPrompt,
					revises: row.revises,
				} as const;
			}
			case "briefing": {
				const prompt = yield* parsed(Contract.BriefingPrompt, row.prompt);
				return { ...head, kind: "briefing", prompt: prompt as BriefingPrompt } as const;
			}
			default:
				return yield* Result.fail(`it is of the kind "${row.kind}"`);
		}
	});

/** A stored thread entry as this code reads it, or why it can't. */
const entryOf = (row: EntryRow): Result.Result<EntryRecord, string> =>
	row.revision > REVISION
		? Result.fail(`it was written at revision ${row.revision}, after this code's`)
		: Result.map(parsed(Contract.Entry, row.body), (entry) => ({
				askId: row.askId,
				seq: row.seq,
				entry: entry as Entry,
				deliveredAt: row.deliveredAt,
			}));

/** A page of closed asks, and where the next one starts. */
export interface ClosedPage {
	readonly records: AskRecord[];
	readonly nextBefore: string | null;
}

/**
 * Persistence for asks and their threads. Storage failing is a defect, not an error to handle.
 *
 * Every ask and entry is stamped with the revision of the contract it was written at. An ask's is the
 * newest any of it was written at, its thread included, so code reading it knows from that alone
 * whether it can. One from a later revision than this code's, as after a rollback, is never read:
 * left out of every list and found by no lookup, so nothing here rewrites it. Everything read is
 * decoded, and a row that doesn't decode is passed over the same way, and logged, rather than
 * handed on. See docs/design/versioned-messages.md.
 */
export class AskStore extends Context.Service<
	AskStore,
	{
		readonly find: (id: string) => Effect.Effect<Option.Option<AskRecord>>;
		/** The newest ask with this key, still open or holding an undelivered reply, waited on since `since`. */
		readonly findRetry: (key: string, since: string) => Effect.Effect<Option.Option<AskRecord>>;
		readonly insert: (record: AskRecord) => Effect.Effect<void>;
		readonly setStatus: (id: string, status: AskStatus, at: string) => Effect.Effect<void>;
		readonly touchWaited: (id: string, at: string) => Effect.Effect<void>;
		/** Shows a task's agent following the ask until `until`; `null` shows it gone. */
		readonly followUntil: (id: string, until: string | null) => Effect.Effect<void>;
		/**
		 * Ends every following that ran out at or before `at`, and names their asks. One statement,
		 * so a poll that extends a following can't be undone by the alarm ending it.
		 */
		readonly endFollows: (at: string) => Effect.Effect<string[]>;
		/** When the soonest following still running runs out, if any is. */
		readonly nextFollowEnd: Effect.Effect<Option.Option<string>>;
		/** An ask's thread. One holding an entry this code can't read is a defect. */
		readonly thread: (id: string) => Effect.Effect<EntryRecord[]>;
		/** The threads of several asks, leaving out each ask whose thread this code can't read. */
		readonly threads: (ids: readonly string[]) => Effect.Effect<Map<string, EntryRecord[]>>;
		readonly append: (askId: string, entry: Entry) => Effect.Effect<EntryRecord>;
		/**
		 * The oldest human entry not yet handed to an agent: replies reach it in the order they were
		 * given, so replies on a briefing are not passed over for a dismissal that followed them.
		 */
		readonly undelivered: (askId: string) => Effect.Effect<Option.Option<EntryRecord>>;
		readonly markDelivered: (askId: string, seq: number, at: string) => Effect.Effect<void>;
		/** Marks every human entry on the ask as handed to the agent. */
		readonly markAllDelivered: (askId: string, at: string) => Effect.Effect<void>;
		/** Every open ask, newest first. */
		readonly open: Effect.Effect<AskRecord[]>;
		/** Up to `limit` closed asks, newest first, closed before `before` when given. */
		readonly closed: (before: string | undefined, limit: number) => Effect.Effect<ClosedPage>;
		/** Records that an agent stopped following the reply to its turn `afterSeq`. */
		readonly cancelTask: (askId: string, afterSeq: number, at: string) => Effect.Effect<void>;
		readonly taskCancelledAt: (
			askId: string,
			afterSeq: number,
		) => Effect.Effect<Option.Option<string>>;
		/** Runs `effect` as one storage transaction. */
		readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("loopback/AskStore") {
	static readonly layer = Layer.effect(
		AskStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			/** The asks among `rows` this code can read. */
			const readable = Effect.fnUntraced(function* (rows: ReadonlyArray<AskRow>) {
				const records: AskRecord[] = [];
				for (const row of rows) {
					const record = askOf(row);
					if (Result.isSuccess(record)) records.push(record.success);
					else
						yield* Effect.logError(
							`Ask ${row.id} can't be read, so it is left out: ${record.failure}.`,
						);
				}
				return records;
			});
			const asks = (statement: Effect.Effect<ReadonlyArray<AskRow>, unknown>) =>
				statement.pipe(Effect.orDie, Effect.flatMap(readable));
			// Rows from a later revision are left out by every query, never read.
			const columns = sql.literal(`
				id, kind, key, status, prompt, project, client, raised_by AS raisedBy, revises,
				created_at AS createdAt, updated_at AS updatedAt, closed_at AS closedAt,
				last_waited_at AS lastWaitedAt, followed_until AS followedUntil
			`);
			const entryColumns = sql.literal(
				"ask_id AS askId, seq, body, delivered_at AS deliveredAt, revision",
			);
			/** An ask's entries, or a defect when one can't be read: an operation must see its whole thread. */
			const entries = (askId: string, rows: ReadonlyArray<EntryRow>) =>
				Effect.forEach(rows, (row) =>
					Result.match(entryOf(row), {
						onSuccess: Effect.succeed,
						onFailure: (why) =>
							Effect.die(new Error(`Entry ${row.seq} of ask ${askId} can't be read: ${why}.`)),
					}),
				);
			const first = <A>(effect: Effect.Effect<A[]>) =>
				Effect.map(effect, (rows) => Option.fromNullishOr(rows[0]));

			return AskStore.of({
				find: (id) =>
					first(
						asks(
							sql<AskRow>`SELECT ${columns} FROM asks WHERE id = ${id} AND revision <= ${REVISION}`,
						),
					),

				findRetry: (key, since) =>
					first(
						asks(sql<AskRow>`
							SELECT ${columns} FROM asks
							WHERE key = ${key}
								AND revision <= ${REVISION}
								AND last_waited_at >= ${since}
								AND (
									status != 'closed'
									OR EXISTS (
										SELECT 1 FROM entries
										WHERE entries.ask_id = asks.id
											AND entries.author = 'human'
											AND entries.delivered_at IS NULL
									)
								)
							ORDER BY created_at DESC
							LIMIT 1
						`),
					),

				insert: (record) =>
					sql`INSERT INTO asks ${sql.insert({
						id: record.id,
						kind: record.kind,
						key: record.key,
						status: record.status,
						prompt: JSON.stringify(record.prompt),
						project: record.project,
						client: record.client,
						raised_by: record.raisedBy === null ? null : JSON.stringify(record.raisedBy),
						revises: record.kind === "review" ? record.revises : null,
						created_at: record.createdAt,
						updated_at: record.updatedAt,
						closed_at: record.closedAt,
						last_waited_at: record.lastWaitedAt,
						followed_until: record.followedUntil,
						revision: REVISION,
					})}`.pipe(Effect.asVoid, Effect.orDie),

				setStatus: (id, status, at) =>
					sql`
						UPDATE asks
						SET status = ${status},
							updated_at = ${at},
							closed_at = ${status === "closed" ? at : null},
							revision = MAX(revision, ${REVISION})
						WHERE id = ${id}
					`.pipe(Effect.asVoid, Effect.orDie),

				touchWaited: (id, at) =>
					sql`UPDATE asks SET last_waited_at = ${at} WHERE id = ${id}`.pipe(
						Effect.asVoid,
						Effect.orDie,
					),

				followUntil: (id, until) =>
					sql`UPDATE asks SET followed_until = ${until} WHERE id = ${id}`.pipe(
						Effect.asVoid,
						Effect.orDie,
					),

				endFollows: (at) =>
					sql<{ readonly id: string }>`
						UPDATE asks SET followed_until = NULL
						WHERE followed_until IS NOT NULL AND followed_until <= ${at}
						RETURNING id
					`.pipe(
						Effect.map((rows) => rows.map((row) => row.id)),
						Effect.orDie,
					),

				nextFollowEnd: sql<{ readonly until: string | null }>`
					SELECT MIN(followed_until) AS until FROM asks WHERE followed_until IS NOT NULL
				`.pipe(
					Effect.map((rows) => Option.fromNullishOr(rows[0]?.until)),
					Effect.orDie,
				),

				thread: (id) =>
					sql<EntryRow>`SELECT ${entryColumns} FROM entries WHERE ask_id = ${id} ORDER BY seq`.pipe(
						Effect.orDie,
						Effect.flatMap((rows) => entries(id, rows)),
					),

				// The ids travel as one JSON parameter: SQLite in a Durable Object binds at most 100.
				threads: (ids) =>
					ids.length === 0
						? Effect.succeed(new Map())
						: sql<EntryRow>`
								SELECT ${entryColumns} FROM entries
								WHERE ask_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
								ORDER BY ask_id, seq
							`.pipe(
								Effect.orDie,
								Effect.flatMap(
									Effect.fnUntraced(function* (rows) {
										const byAsk = new Map<string, EntryRecord[]>(ids.map((id) => [id, []]));
										for (const row of rows) {
											const thread = byAsk.get(row.askId);
											if (thread === undefined) continue;
											const entry = entryOf(row);
											if (Result.isSuccess(entry)) {
												thread.push(entry.success);
											} else {
												byAsk.delete(row.askId);
												yield* Effect.logError(
													`Ask ${row.askId} can't be read, so it is left out: entry ${row.seq} can't, as ${entry.failure}.`,
												);
											}
										}
										return byAsk;
									}),
								),
							),

				append: (askId, entry) =>
					Effect.gen(function* () {
						const [row] = yield* sql<{ readonly next: number }>`
							SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries WHERE ask_id = ${askId}
						`;
						const seq = row?.next ?? 1;
						yield* sql`INSERT INTO entries ${sql.insert({
							ask_id: askId,
							seq,
							author: entry.author,
							body: JSON.stringify(entry),
							delivered_at: null,
							revision: REVISION,
						})}`;
						yield* sql`UPDATE asks SET revision = MAX(revision, ${REVISION}) WHERE id = ${askId}`;
						return { askId, seq, entry, deliveredAt: null };
					}).pipe(Effect.orDie),

				undelivered: (askId) =>
					sql<EntryRow>`
						SELECT ${entryColumns} FROM entries
						WHERE ask_id = ${askId} AND author = 'human' AND delivered_at IS NULL
						ORDER BY seq
						LIMIT 1
					`.pipe(
						Effect.orDie,
						Effect.flatMap((rows) => entries(askId, rows)),
						Effect.map((found) => Option.fromNullishOr(found[0])),
					),

				markDelivered: (askId, seq, at) =>
					sql`
						UPDATE entries SET delivered_at = ${at}
						WHERE ask_id = ${askId} AND seq = ${seq} AND delivered_at IS NULL
					`.pipe(Effect.asVoid, Effect.orDie),

				markAllDelivered: (askId, at) =>
					sql`
						UPDATE entries SET delivered_at = ${at}
						WHERE ask_id = ${askId} AND author = 'human' AND delivered_at IS NULL
					`.pipe(Effect.asVoid, Effect.orDie),

				open: asks(sql<AskRow>`
					SELECT ${columns} FROM asks
					WHERE status != 'closed' AND revision <= ${REVISION}
					ORDER BY created_at DESC
				`),

				// One row past the page says whether there is another, counted before any is left out.
				closed: (before, limit) =>
					(before === undefined
						? sql<AskRow>`
								SELECT ${columns} FROM asks
								WHERE status = 'closed' AND revision <= ${REVISION}
								ORDER BY closed_at DESC LIMIT ${limit + 1}
							`
						: sql<AskRow>`
								SELECT ${columns} FROM asks
								WHERE status = 'closed' AND revision <= ${REVISION} AND closed_at < ${before}
								ORDER BY closed_at DESC LIMIT ${limit + 1}
							`
					).pipe(
						Effect.orDie,
						Effect.flatMap((rows) =>
							Effect.map(readable(rows.slice(0, limit)), (records) => ({
								records,
								nextBefore: rows.length > limit ? (rows[limit - 1]?.closedAt ?? null) : null,
							})),
						),
					),

				cancelTask: (askId, afterSeq, at) =>
					sql`
						INSERT OR IGNORE INTO task_cancellations (ask_id, after_seq, cancelled_at)
						VALUES (${askId}, ${afterSeq}, ${at})
					`.pipe(Effect.asVoid, Effect.orDie),

				taskCancelledAt: (askId, afterSeq) =>
					sql<{ readonly cancelledAt: string }>`
						SELECT cancelled_at AS cancelledAt FROM task_cancellations
						WHERE ask_id = ${askId} AND after_seq = ${afterSeq}
					`.pipe(
						Effect.map((rows) =>
							Option.map(Option.fromNullishOr(rows[0]), (row) => row.cancelledAt),
						),
						Effect.orDie,
					),

				transaction: (effect) =>
					sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die)),
			});
		}),
	);
}

/** Persistence for event tickets, kept only by their hash. */
export class TicketStore extends Context.Service<
	TicketStore,
	{
		readonly insert: (tokenHash: string, actorId: string, expiresAt: string) => Effect.Effect<void>;
		/** Removes the ticket and gives back who it was for and until when; none if it is unknown. */
		readonly take: (
			tokenHash: string,
		) => Effect.Effect<Option.Option<{ readonly actorId: string; readonly expiresAt: string }>>;
		/** Forgets tickets that expired before `at`. */
		readonly purge: (at: string) => Effect.Effect<void>;
	}
>()("loopback/TicketStore") {
	static readonly layer = Layer.effect(
		TicketStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return TicketStore.of({
				insert: (tokenHash, actorId, expiresAt) =>
					sql`INSERT INTO event_tickets ${sql.insert({
						token_hash: tokenHash,
						actor_id: actorId,
						expires_at: expiresAt,
					})}`.pipe(Effect.asVoid, Effect.orDie),
				take: (tokenHash) =>
					sql<{ readonly actorId: string; readonly expiresAt: string }>`
						DELETE FROM event_tickets WHERE token_hash = ${tokenHash}
						RETURNING actor_id AS actorId, expires_at AS expiresAt
					`.pipe(
						Effect.map((rows) => Option.fromNullishOr(rows[0])),
						Effect.orDie,
					),
				purge: (at) =>
					sql`DELETE FROM event_tickets WHERE expires_at < ${at}`.pipe(Effect.asVoid, Effect.orDie),
			});
		}),
	);
}

export interface UploadRecord {
	readonly id: string;
	readonly tokenHash: string;
	readonly contentType: ImageType;
	readonly maxBytes: number;
	readonly status: "pending" | "claimed" | "stored";
	readonly size: number | null;
	readonly createdAt: string;
	readonly expiresAt: string;
}

/** Persistence for upload tickets and the uploads they produce. */
export class UploadStore extends Context.Service<
	UploadStore,
	{
		readonly insert: (record: UploadRecord) => Effect.Effect<void>;
		readonly find: (id: string) => Effect.Effect<Option.Option<UploadRecord>>;
		readonly findByToken: (tokenHash: string) => Effect.Effect<Option.Option<UploadRecord>>;
		readonly setStatus: (
			id: string,
			status: UploadRecord["status"],
			size: number | null,
		) => Effect.Effect<void>;
	}
>()("loopback/UploadStore") {
	static readonly layer = Layer.effect(
		UploadStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = sql.literal(`
				id, token_hash AS tokenHash, content_type AS contentType, max_bytes AS maxBytes,
				status, size, created_at AS createdAt, expires_at AS expiresAt
			`);
			const one = (statement: Effect.Effect<ReadonlyArray<UploadRecord>, unknown>) =>
				statement.pipe(
					Effect.map((rows) => Option.fromNullishOr(rows[0])),
					Effect.orDie,
				);
			return UploadStore.of({
				insert: (record) =>
					sql`INSERT INTO uploads ${sql.insert({
						id: record.id,
						token_hash: record.tokenHash,
						content_type: record.contentType,
						max_bytes: record.maxBytes,
						status: record.status,
						size: record.size,
						created_at: record.createdAt,
						expires_at: record.expiresAt,
					})}`.pipe(Effect.asVoid, Effect.orDie),
				find: (id) => one(sql<UploadRecord>`SELECT ${columns} FROM uploads WHERE id = ${id}`),
				findByToken: (tokenHash) =>
					one(sql<UploadRecord>`SELECT ${columns} FROM uploads WHERE token_hash = ${tokenHash}`),
				setStatus: (id, status, size) =>
					sql`UPDATE uploads SET status = ${status}, size = ${size} WHERE id = ${id}`.pipe(
						Effect.asVoid,
						Effect.orDie,
					),
			});
		}),
	);
}
