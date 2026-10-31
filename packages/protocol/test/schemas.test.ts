import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OPENAPI_VERSIONS } from "../src/generated/document.gen.ts";
import { Ask, AskPage, REVISION, REVISIONS, ServerEvent, Snapshot } from "../src/schema.ts";

/**
 * Readers decode the contract with the generated schemas. Every revision's messages are frozen as
 * examples in `revisions/<n>.examples.json`, and current code must read them all. A message from a
 * newer revision decodes to an `unknown` member rather than failing what holds it.
 */

const root = join(import.meta.dirname, "..");

type Examples = Record<string, readonly unknown[]>;

const exampleRevisions = readdirSync(join(root, "revisions"))
	.flatMap((name) => /^(\d+)\.examples\.json$/.exec(name)?.[1] ?? [])
	.map(Number);

/** Every place a decoded message says it was read as `unknown`, by path. */
const unknownsIn = (value: unknown, path = "$"): string[] => {
	if (Array.isArray(value))
		return value.flatMap((item, index) => unknownsIn(item, `${path}[${index}]`));
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	const here = ["kind", "type", "outcome"].some((tag) => record[tag] === "unknown") ? [path] : [];
	return [
		...here,
		...Object.entries(record).flatMap(([key, inner]) => unknownsIn(inner, `${path}.${key}`)),
	];
};

describe("the generated schemas", () => {
	it("are at the latest revision the spec declares", () => {
		expect(REVISION).toBe(Number(OPENAPI_VERSIONS.at(-1)));
		expect([...REVISIONS]).toEqual(OPENAPI_VERSIONS.map(Number));
	});

	it("have frozen examples for every revision", () => {
		expect(exampleRevisions.toSorted((a, b) => a - b)).toEqual([...REVISIONS]);
	});

	describe.each(exampleRevisions)("revision %s's examples", (revision) => {
		const examples = JSON.parse(
			readFileSync(join(root, `revisions/${revision}.examples.json`), "utf8"),
		) as Examples;

		it("each decode exactly, at their own revision, as what they are", async () => {
			const generated = (await import(`../src/generated/schemas.r${revision}.gen.ts`)) as Record<
				string,
				Schema.Top
			>;
			for (const [name, messages] of Object.entries(examples)) {
				const schema = generated[name] as Schema.Codec<unknown>;
				expect(schema, name).toBeDefined();
				for (const message of messages) {
					const decoded = Schema.decodeUnknownSync(schema)(message, { onExcessProperty: "error" });
					expect(unknownsIn(decoded), `${name}: ${JSON.stringify(message).slice(0, 80)}`).toEqual(
						[],
					);
				}
			}
		});

		it("each decode at the latest revision", async () => {
			const latest = (await import("../src/schema.ts")) as unknown as Record<string, Schema.Top>;
			for (const [name, messages] of Object.entries(examples)) {
				const schema = latest[name] as Schema.Codec<unknown>;
				for (const message of messages) {
					expect(unknownsIn(Schema.decodeUnknownSync(schema)(message)), name).toEqual([]);
				}
			}
		});
	});
});

const question = {
	kind: "question",
	id: "ask_1",
	status: "awaiting_human",
	waiting: true,
	project: "loopback",
	prompt: { question: "Ship it?", options: [{ label: "Yes" }], multiple: false },
	thread: [],
	createdAt: "2026-10-30T09:00:00.000Z",
	updatedAt: "2026-10-30T09:01:00.000Z",
};

const review = {
	...question,
	kind: "review",
	prompt: { title: "Copy", content: [{ type: "markdown", text: "Hello." }] },
};

describe("a message from a newer revision", () => {
	it("of a kind of ask this reader doesn't know reads as an unknown ask, keeping what it can show", () => {
		expect(
			Schema.decodeUnknownSync(Ask)({ ...question, kind: "poll", prompt: { choices: 3 } }),
		).toEqual({
			kind: "unknown",
			was: "poll",
			id: "ask_1",
			status: "awaiting_human",
			project: "loopback",
			createdAt: "2026-10-30T09:00:00.000Z",
			updatedAt: "2026-10-30T09:01:00.000Z",
		});
	});

	it("with a status this reader doesn't know reads as an unknown ask, closed so it asks nothing", () => {
		expect(Schema.decodeUnknownSync(Ask)({ ...question, status: "snoozed" })).toMatchObject({
			kind: "unknown",
			was: "question",
			status: "closed",
		});
	});

	it("with a block it doesn't know keeps the ask, and only that block is unknown", () => {
		const decoded = Schema.decodeUnknownSync(Ask)({
			...review,
			prompt: {
				title: "Copy",
				content: [
					{ type: "markdown", text: "Hi." },
					{ type: "chart", data: [1] },
				],
			},
		});
		expect(decoded).toMatchObject({
			kind: "review",
			prompt: {
				content: [
					{ type: "markdown", text: "Hi." },
					{ type: "unknown", was: "chart" },
				],
			},
		});
	});

	it("with a reply it doesn't know keeps the ask, and only that reply is unknown", () => {
		const decoded = Schema.decodeUnknownSync(Ask)({
			...review,
			thread: [
				{
					author: "human",
					reply: { outcome: "snoozed", until: "later" },
					at: "2026-10-30T09:02:00.000Z",
				},
			],
		});
		expect(decoded).toMatchObject({
			kind: "review",
			thread: [{ reply: { outcome: "unknown", was: "snoozed" } }],
		});
	});

	it("among others in a snapshot or a page leaves the others as they are", () => {
		const unknown = { ...question, id: "ask_2", kind: "poll" };
		expect(
			unknownsIn(Schema.decodeUnknownSync(Snapshot)({ open: [question, unknown], recent: [] })),
		).toEqual(["$.open[1]"]);
		expect(unknownsIn(Schema.decodeUnknownSync(AskPage)({ items: [unknown, review] }))).toEqual([
			"$.items[0]",
		]);
	});

	it("on the event socket, of a type it doesn't know, reads as an unknown frame", () => {
		expect(Schema.decodeUnknownSync(ServerEvent)({ type: "ask.deleted", id: "ask_1" })).toEqual({
			type: "unknown",
			was: "ask.deleted",
		});
	});

	it("with fields this reader doesn't know reads as what it knows, the rest dropped", () => {
		const decoded = Schema.decodeUnknownSync(Ask)({ ...question, priority: "high" });
		expect(decoded).toMatchObject({ kind: "question", id: "ask_1" });
		expect(decoded).not.toHaveProperty("priority");
	});
});

describe("something that isn't a message", () => {
	it("still fails", () => {
		expect(() => Schema.decodeUnknownSync(Ask)({ nonsense: true })).toThrow();
		expect(() => Schema.decodeUnknownSync(ServerEvent)("ping")).toThrow();
	});
});
