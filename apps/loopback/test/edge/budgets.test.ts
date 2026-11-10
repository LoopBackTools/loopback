import { describe, expect, it } from "vitest";
import { budgetsFor, PLANS } from "../../src/edge/budgets.ts";

describe("budgets", () => {
	it("on Paid, waits until the reply", () => {
		expect(budgetsFor("paid")).toEqual({ waitMs: Infinity, keepAliveMs: 25_000 });
	});

	it("on Free, ends a wait after ten minutes, keeping alive as often", () => {
		expect(budgetsFor("free")).toEqual({ waitMs: 600_000, keepAliveMs: 25_000 });
		expect(PLANS.free.waitMs).toBeLessThan(PLANS.paid.waitMs);
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
		expect(() => budgetsFor("paid", { keepAliveMs: -1 })).toThrow(/keepAliveMs/);
	});
});
