import { describe, expect, it } from "@effect/vitest";
import { exports } from "cloudflare:workers";
import { Effect } from "effect";
import type { Space } from "../src/space/object.ts";
import { Spaces } from "../src/spaces.ts";
import { caller } from "./caller.ts";

describe("the core's spaces", () => {
	// A core created seconds ago can run before its `Space` class is bound: `exports.Space` was
	// undefined on Cloudflare, then bound (measured on hosted Loopback's rehearsal, 2026-11-11). A
	// runtime built then must reach the class once it is, not keep what it saw first.
	it.effect(
		"reaches the Space class once it is bound, though it wasn't when they were built",
		() => {
			let bound = false;
			const namespace = () =>
				(bound ? exports.Space : undefined) as unknown as DurableObjectNamespace<Space>;
			return Effect.gen(function* () {
				const spaces = yield* Spaces;
				expect(() => spaces.idOf("lazy")).toThrow(TypeError);
				bound = true;
				expect(spaces.idOf("lazy")).toBe(exports.Space.idFromName("lazy").toString());
			}).pipe(Effect.provide(Spaces.layer(namespace, caller)));
		},
	);
});
