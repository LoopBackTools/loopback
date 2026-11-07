import { describe, expect, it } from "@effect/vitest";
import { budgetsFor, PLANS } from "../src/budgets.ts";

describe("budgets", () => {
	it("paid keeps today's behaviour", () => {
		expect(budgetsFor("paid")).toEqual({
			waitMs: Infinity,
			keepAliveMs: 25_000,
			pollMs: [2_000, 10_000, 30_000],
		});
	});

	it("ends free's waits, and polls it less often", () => {
		expect(PLANS.free.waitMs).toBeLessThan(Infinity);
		expect(PLANS.free.pollMs[0]).toBeGreaterThan(PLANS.paid.pollMs[0]);
	});

	it("an override replaces only its own budget", () => {
		expect(budgetsFor("free", { waitMs: 1_000 })).toEqual({ ...PLANS.free, waitMs: 1_000 });
	});

	it("refuses a keep-alive over 50 s, which a client's 60 s timeout would outlast", () => {
		expect(() => budgetsFor("paid", { keepAliveMs: 50_001 })).toThrow(/keepAliveMs/);
		expect(budgetsFor("paid", { keepAliveMs: 50_000 }).keepAliveMs).toBe(50_000);
	});

	it("refuses a budget that isn't a positive number", () => {
		expect(() => budgetsFor("paid", { waitMs: 0 })).toThrow(/waitMs/);
		expect(() => budgetsFor("paid", { pollMs: [2_000, -1, 30_000] })).toThrow(/pollMs/);
	});
});
