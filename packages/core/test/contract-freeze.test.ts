import { REVISION } from "@loopbacktools/protocol/schema";
import { describe, expect, it } from "vitest";
import { Core } from "../src/core.ts";
import r2 from "./contract.r2.json" with { type: "json" };

/**
 * What the core serves an edge over RPC, held to the contract's revisions. A core is deployed before
 * its edge and serves edges at its own revision or older, so a method an older edge calls is never
 * taken away, and this revision's are recorded in `contract.r<N>.json`: changing them means updating
 * the record, in the same revision only until it ships.
 */

/** The methods `Core` serves, by name. */
const served = Object.getOwnPropertyNames(Core.prototype)
	.filter((name) => name !== "constructor")
	.toSorted();

/**
 * Each revision's recorded methods, by revision. A new revision of the contract fails the first test
 * below until its record is written here.
 */
const recorded: Readonly<Record<number, { readonly methods: readonly string[] }>> = { 2: r2 };

describe("the core's RPC", () => {
	it(`is recorded for this revision of the contract, ${REVISION}, as it is`, () => {
		expect(recorded[REVISION]?.methods, `contract.r${REVISION}.json`).toEqual(served);
	});

	it.each(Object.keys(recorded).map(Number))(
		"still serves every method an edge at revision %i calls",
		(revision) => {
			expect(recorded[revision]?.methods.filter((name) => !served.includes(name))).toEqual([]);
		},
	);
});
