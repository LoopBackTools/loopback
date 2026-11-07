import { describe, expect, it } from "vitest";
import { planFrom, planNotice } from "../plan.ts";

describe("the plan a deploy is for", () => {
	it("is Paid only when LOOPBACK_PLAN says paid, however it is written", () => {
		expect(planFrom("paid")).toBe("paid");
		expect(planFrom("Paid")).toBe("paid");
		expect(planFrom(" PAID ")).toBe("paid");
		expect(planFrom("free")).toBe("free");
		expect(planFrom(undefined)).toBe("free");
	});

	it("says so when a deploy falls back to Free, so a Paid deployment isn't switched unseen", () => {
		expect(planNotice(undefined)).toMatch(/Workers Free/);
		expect(planNotice(undefined)).toMatch(/LOOPBACK_PLAN=paid/);
		expect(planNotice("paid")).toBeUndefined();
	});

	it("names a value it doesn't know", () => {
		expect(planNotice("pro")).toMatch(/"pro"/);
	});
});
