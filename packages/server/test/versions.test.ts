import { REVISION } from "@loopbacktools/protocol/schema";
import { describe, expect, it } from "@effect/vitest";
import { env, exports } from "cloudflare:workers";
import { Effect, Exit } from "effect";
import { BUILD_HEADER, buildOf, encodeExit, Outdated, spaceClient } from "../src/space/rpc.ts";
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
