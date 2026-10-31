import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENAPI_VERSIONS } from "../src/generated/document.gen.ts";

/**
 * The contract can't change shape without a new revision. Every revision the spec declares is frozen
 * in `revisions/`, and the spec must go on emitting each one unchanged: changing a message without
 * declaring a revision changes the latest one, and editing a shipped revision changes an older one.
 * Wording is free to change: descriptions, titles, summaries and examples are not shape.
 */

const root = join(import.meta.dirname, "..");

/** Keys that describe a message without changing what a reader must accept. */
const PROSE = new Set(["description", "title", "summary", "example", "examples", "externalDocs"]);

/**
 * A document's shape: its paths and schemas, without prose. The revision list itself is left out:
 * declaring a revision adds to it in every document, older ones included.
 */
const shapeOf = (document: { paths?: unknown; components?: { schemas?: object } }) => {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (typeof value !== "object" || value === null) return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !PROSE.has(key))
				.map(([key, inner]) => [key, strip(inner)]),
		);
	};
	const { Revisions: _, ...schemas } = (document.components?.schemas ?? {}) as Record<
		string,
		unknown
	>;
	return strip({ paths: document.paths, schemas });
};

const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as object;

const revisionsIn = (folder: string, pattern: RegExp) =>
	readdirSync(join(root, folder))
		.flatMap((name) => pattern.exec(name)?.[1] ?? [])
		.toSorted((a, b) => Number(a) - Number(b));

const emitted = revisionsIn("openapi", /^openapi\.(\d+)\.json$/);
const frozen = revisionsIn("revisions", /^(\d+)\.json$/);

describe("the contract's revisions", () => {
	it("are numbered from 1, in the order the spec declares them", () => {
		expect([...OPENAPI_VERSIONS]).toEqual(OPENAPI_VERSIONS.map((_, index) => String(index + 1)));
		expect(emitted).toEqual([...OPENAPI_VERSIONS]);
	});

	it("are each frozen: run `pnpm freeze` once after declaring one", () => {
		expect(frozen).toEqual(emitted);
	});

	it.each(frozen)("still emit revision %s exactly as it was frozen", (revision) => {
		expect(shapeOf(read(`openapi/openapi.${revision}.json`))).toEqual(
			shapeOf(read(`revisions/${revision}.json`)),
		);
	});

	it("publish the latest as the package's OpenAPI document", () => {
		const manifest = read("package.json") as {
			exports: Record<string, unknown>;
			publishConfig: { exports: Record<string, unknown> };
		};
		const latest = `./openapi/openapi.${emitted.at(-1)}.json`;
		expect(manifest.exports["./openapi.json"]).toBe(latest);
		expect(manifest.publishConfig.exports["./openapi.json"]).toBe(latest);
	});
});
