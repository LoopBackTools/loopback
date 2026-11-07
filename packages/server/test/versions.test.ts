import { REVISION } from "@loopbacktools/protocol/schema";
import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Exit } from "effect";
import { BUILD_HEADER, REVISION_HEADER } from "@loopbacktools/protocol";
import { buildOf, encodeExit, Outdated, spaceClient } from "../src/space/rpc.ts";
import { caller } from "./caller.ts";

/**
 * For a while after a deploy, the Worker and a space can run different code. A space called by newer
 * code refuses, running nothing, and restarts onto it; the Worker tries the call again. Older code
 * calling a newer space carries on. See docs/design/versioned-messages.md.
 */

const OWNER = { id: "owner" };
const own = buildOf(env);
const later = new Date(Date.parse(own ?? "") + 60_000).toISOString();
const earlier = new Date(Date.parse(own ?? "") - 60_000).toISOString();

const question = (text: string) => ({
	actor: OWNER,
	kind: "question" as const,
	input: { question: text, options: [{ label: "Yes" }, { label: "No" }], project: "versions" },
});

let spaces = 0;
/**
 * A space of its own for each test, on the code the tests run. A stub is no use once its object has
 * reset, so each is taken anew, as the Worker's client does.
 */
const freshSpace = () => {
	const name = `versions-${(spaces += 1)}`;
	return () => exports.Space.getByName(name);
};

/** Whether a call's encoded answer is the space refusing it as Outdated. */
const isOutdated = (json: unknown) => JSON.stringify(json).includes('"_tag":"Outdated"');

/**
 * Each test starts a space from cold, which can take seconds while the rest of the suite runs
 * alongside it: well past vitest's default of five.
 */
const COLD_START = 15_000;

/** Long enough for a space that refused newer code to have restarted. */
const restarted = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("a space called by newer code", () => {
	it("has a build to compare, from the deployment's version metadata", () => {
		expect(own).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it(
		"refuses, running nothing, and restarts onto it",
		async () => {
			const stub = freshSpace();
			const refused = await stub().call("open", [question("From the future?")], {
				revision: REVISION,
				build: later,
			});
			expect(isOutdated(refused)).toBe(true);
			await restarted();
			const snapshot = await Effect.runPromise(spaceClient(stub, caller).snapshot());
			expect(snapshot.open).toEqual([]);
		},
		COLD_START,
	);

	it(
		"refuses whatever reaches it until it has restarted, whoever calls",
		async () => {
			const held = freshSpace()();
			await held.call("snapshot", [], { revision: REVISION, build: later });
			expect(isOutdated(await held.call("snapshot", [], caller))).toBe(true);
			await restarted();
		},
		COLD_START,
	);

	it(
		"refuses a call writing a later revision of the contract, where there is no build to compare",
		async () => {
			const stub = freshSpace();
			const refused = await stub().call("open", [question("From a later contract?")], {
				revision: REVISION + 1,
			});
			expect(isOutdated(refused)).toBe(true);
			await restarted();
			const snapshot = await Effect.runPromise(spaceClient(stub, caller).snapshot());
			expect(snapshot.open).toEqual([]);
		},
		COLD_START,
	);

	it(
		"refuses an inbox's socket handed over by a later revision",
		async () => {
			const response = await freshSpace()().fetch(
				new Request("https://space/events", {
					headers: { Upgrade: "websocket", [REVISION_HEADER]: String(REVISION + 1) },
				}),
			);
			expect(response.status).toBe(503);
			await restarted();
		},
		COLD_START,
	);

	it(
		"refuses an inbox's socket, which reconnects",
		async () => {
			const response = await freshSpace()().fetch(
				new Request("https://space/events", {
					headers: { Upgrade: "websocket", [BUILD_HEADER]: later },
				}),
			);
			expect(response.status).toBe(503);
			await restarted();
		},
		COLD_START,
	);
});

describe("a space called by older code", () => {
	it(
		"carries on, as it does for code from before callers named their version",
		async () => {
			const stub = freshSpace();
			const space = spaceClient(stub, { revision: REVISION, build: earlier });
			const ask = await Effect.runPromise(space.open(question("From the past?")));
			expect(ask.kind).toBe("question");
			const unnamed = await stub().call("get", [ask.id], undefined as never);
			expect(isOutdated(unnamed)).toBe(false);
		},
		COLD_START,
	);
});

describe("a space's inboxes", () => {
	/** An inbox's socket onto the space, and the frames and close it hears. */
	const listen = async (stub: DurableObjectStub) => {
		const response = await stub.fetch(
			new Request("https://space/events", { headers: { Upgrade: "websocket" } }),
		);
		const socket = response.webSocket;
		if (socket === null) throw new Error("no socket");
		const frames: string[] = [];
		const closed = new Promise<number>((resolve) => {
			socket.addEventListener("close", (event) => resolve(event.code));
		});
		socket.addEventListener("message", (event) => frames.push(String(event.data)));
		socket.accept();
		return { socket, frames, closed };
	};

	it.live(
		"are closed rather than sent what their page may not read, once other code accepted them",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const theirs = yield* Effect.promise(() => listen(stub()));
				// As if accepted before a deploy, then kept through hibernation.
				yield* Effect.promise(() =>
					runInDurableObject(stub(), (_, state) => {
						for (const older of state.getWebSockets()) {
							older.serializeAttachment({ revision: REVISION, build: earlier });
						}
					}),
				);
				const ours = yield* Effect.promise(() => listen(stub()));
				yield* spaceClient(stub, caller).open(question("Who hears this?"));
				expect(yield* Effect.promise(() => theirs.closed)).toBe(1012);
				expect(theirs.frames.some((frame) => frame.includes("ask.opened"))).toBe(false);
				yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
				expect(ours.frames.some((frame) => frame.includes("ask.opened"))).toBe(true);
				ours.socket.close();
			}),
		COLD_START,
	);
});

describe("a space reading what it is called with", () => {
	/** Whether a call died unread: what a space does with arguments it can't read. */
	const unread = <A, E>(exit: Exit.Exit<A, E>) =>
		Exit.hasDies(exit) &&
		exit.cause.reasons.some(
			(reason) =>
				reason._tag === "Die" && String(reason.defect).includes("can't read its arguments"),
		);

	/** A call the space must refuse, typed as the caller never could. */
	const unchecked = (args: unknown) => args as never;

	it.live(
		"refuses an ask of a kind it does not know, keeping nothing",
		() =>
			Effect.gen(function* () {
				const space = spaceClient(freshSpace(), caller);
				const memo = { ...question("A memo?"), kind: "memo" };
				expect(unread(yield* Effect.exit(space.open(unchecked(memo))))).toBe(true);
				expect((yield* space.snapshot()).open).toEqual([]);
			}),
		COLD_START,
	);

	it.live(
		"refuses a review showing a block it does not know",
		() =>
			Effect.gen(function* () {
				const space = spaceClient(freshSpace(), caller);
				const chart = {
					actor: OWNER,
					kind: "review",
					input: { title: "Revenue", content: [{ type: "chart", series: [1, 2, 3] }] },
				};
				expect(unread(yield* Effect.exit(space.open(unchecked(chart))))).toBe(true);
				expect((yield* space.snapshot()).open).toEqual([]);
			}),
		COLD_START,
	);

	it.live(
		"refuses a reply with an outcome it does not know, leaving the ask as it was",
		() =>
			Effect.gen(function* () {
				const space = spaceClient(freshSpace(), caller);
				const ask = yield* space.open(question("Snooze me?"));
				const snoozed = space.reply(ask.id, unchecked({ outcome: "snoozed" }), OWNER);
				expect(unread(yield* Effect.exit(snoozed))).toBe(true);
				expect(yield* space.get(ask.id)).toMatchObject({ status: "awaiting_human", thread: [] });
			}),
		COLD_START,
	);

	it.live(
		"refuses arguments of the wrong shape",
		() =>
			Effect.gen(function* () {
				const space = spaceClient(freshSpace(), caller);
				const ask = yield* space.open(question("Wait for me?"));
				expect(unread(yield* Effect.exit(space.markDelivered(ask.id, unchecked("soon"))))).toBe(
					true,
				);
				expect(unread(yield* Effect.exit(space.get(unchecked(7))))).toBe(true);
			}),
		COLD_START,
	);
});

describe("a space's stored asks", () => {
	/** Each ask's revision, and each of its entries', as the space holds them. */
	const revisions = (stub: DurableObjectStub) =>
		runInDurableObject(stub, (_, state) => ({
			asks: state.storage.sql.exec("SELECT id, revision FROM asks").toArray(),
			entries: state.storage.sql.exec("SELECT ask_id, seq, revision FROM entries").toArray(),
		}));

	it.live(
		"are stamped with the revision they were written at, as is each entry in their threads",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const space = spaceClient(stub, caller);
				const ask = yield* space.open(question("Stamped?"));
				yield* space.reply(ask.id, { outcome: "dismissed" }, OWNER);
				const stored = yield* Effect.promise(() => revisions(stub()));
				expect(stored.asks).toEqual([{ id: ask.id, revision: REVISION }]);
				expect(stored.entries).toEqual([{ ask_id: ask.id, seq: 1, revision: REVISION }]);
			}),
		COLD_START,
	);

	/** Runs SQL against a space's storage, as other code might have left it. */
	const exec = (stub: DurableObjectStub, query: string, ...bindings: unknown[]) =>
		Effect.promise(() =>
			runInDurableObject(stub, (_, state) => state.storage.sql.exec(query, ...bindings).toArray()),
		);

	it.live(
		"from a later revision, as after a rollback, are left out, found by nothing, and left as they are",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const space = spaceClient(stub, caller);
				const newer = yield* space.open(question("Written by newer code?"));
				const ours = yield* space.open(question("Written by this code?"));
				yield* exec(stub(), "UPDATE asks SET revision = ? WHERE id = ?", REVISION + 1, newer.id);
				expect((yield* space.snapshot()).open.map((ask) => ask.id)).toEqual([ours.id]);
				expect(yield* Effect.flip(space.get(newer.id))).toMatchObject({ _tag: "AskNotFound" });
				const replied = space.reply(newer.id, { outcome: "dismissed" }, OWNER);
				expect(yield* Effect.flip(replied)).toMatchObject({ _tag: "AskNotFound" });
				expect(
					yield* exec(stub(), "SELECT status, revision FROM asks WHERE id = ?", newer.id),
				).toEqual([{ status: "awaiting_human", revision: REVISION + 1 }]);
				expect(yield* exec(stub(), "SELECT * FROM entries WHERE ask_id = ?", newer.id)).toEqual([]);
			}),
		COLD_START,
	);

	it.live(
		"that can't be read are left out of history without ending it",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const space = spaceClient(stub, caller);
				const closed: string[] = [];
				for (const text of ["First?", "Second?", "Third?"]) {
					const ask = yield* space.open(question(text));
					yield* space.reply(ask.id, { outcome: "dismissed" }, OWNER);
					closed.unshift(ask.id);
					yield* Effect.sleep("5 millis");
				}
				const [third, second, first] = closed;
				yield* exec(stub(), "UPDATE asks SET prompt = '{}' WHERE id = ?", second);
				const page = yield* space.history(undefined, 2);
				expect(page.items.map((ask) => ask.id)).toEqual([third]);
				expect(page.nextBefore).toBeDefined();
				const rest = yield* space.history(page.nextBefore, 2);
				expect(rest.items.map((ask) => ask.id)).toEqual([first]);
			}),
		COLD_START,
	);

	it.live(
		"whose thread can't be read are left out of the snapshot, which still serves the rest",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const space = spaceClient(stub, caller);
				const broken = yield* space.open(question("Broken thread?"));
				const fine = yield* space.open(question("Fine thread?"));
				yield* space.reply(broken.id, { outcome: "dismissed" }, OWNER);
				yield* exec(stub(), "UPDATE entries SET body = 'not json' WHERE ask_id = ?", broken.id);
				const snapshot = yield* space.snapshot();
				expect([...snapshot.open, ...snapshot.recent].map((ask) => ask.id)).toEqual([fine.id]);
			}),
		COLD_START,
	);

	it.live(
		"are revision 1 when written without one, as by code from before revisions were kept",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				yield* spaceClient(stub, caller).snapshot();
				const stored = yield* Effect.promise(() =>
					runInDurableObject(stub(), (_, state) => {
						state.storage.sql.exec(
							`INSERT INTO asks (id, kind, key, status, prompt, created_at, updated_at)
							VALUES ('old', 'question', 'k', 'closed', '{}', '2026-01-01', '2026-01-01')`,
						);
						return state.storage.sql.exec("SELECT revision FROM asks WHERE id = 'old'").one();
					}),
				);
				expect(stored).toEqual({ revision: 1 });
			}),
		COLD_START,
	);
});

describe("the client, refused as Outdated", () => {
	it.live(
		"tries again whatever the call is, even a reply, which then runs once",
		() =>
			Effect.gen(function* () {
				const stub = freshSpace();
				const space = spaceClient(stub, caller);
				const ask = yield* space.open(question("Retried?"));
				let refusals = 2;
				let calls = 0;
				const restarting = spaceClient(
					() => ({
						call: (method, args, from) => {
							calls += 1;
							if (refusals > 0) {
								refusals -= 1;
								return Promise.resolve(encodeExit(Exit.fail(new Outdated())));
							}
							return stub().call(method, args, from);
						},
					}),
					caller,
				);
				const closed = yield* restarting.reply(ask.id, { outcome: "dismissed" }, OWNER);
				expect(closed.status).toBe("closed");
				expect(calls).toBe(3);
				expect((yield* space.get(ask.id)).thread).toHaveLength(1);
			}),
		COLD_START,
	);

	it.live(
		"gives up as a fault when the space never moves onto the new code",
		() =>
			Effect.gen(function* () {
				const never = spaceClient(
					() => ({ call: () => Promise.resolve(encodeExit(Exit.fail(new Outdated()))) }),
					caller,
				);
				const exit = yield* Effect.exit(never.snapshot());
				expect(Exit.hasDies(exit)).toBe(true);
			}),
		COLD_START,
	);
});
