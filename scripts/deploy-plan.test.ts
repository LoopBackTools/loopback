import { describe, expect, it } from "vitest";
import { type Observed, planDeploy } from "./deploy-plan.ts";

/**
 * One deploy installs Loopback fresh, upgrades a 0.7 install by moving its spaces into the core, or
 * deploys both Workers again, and an interrupted run finishes when it is run again. The planner
 * decides which from what the account holds; these are the cases it must get right.
 */

const TOKENS = JSON.stringify({ owner: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" });

/** An account holding nothing of this deployment. */
const nothing: Observed = {
	edgeHoldsSpace: false,
	coreExists: false,
	coreHoldsSpace: false,
	transferPending: false,
	edgeSecrets: [],
};

/** A 0.7 install: one Worker holding the spaces and the bucket, with its one token. */
const from07: Observed = {
	...nothing,
	edgeHoldsSpace: true,
	edgeFilesBucket: "loopback-files",
	edgeSecrets: ["LOOPBACK_TOKEN"],
};

/** A 0.8 install: the core holds the spaces and the bucket, the edge the tokens. */
const on08: Observed = {
	...nothing,
	coreExists: true,
	coreHoldsSpace: true,
	coreFilesBucket: "loopback-files",
	edgeSecrets: ["LOOPBACK_TOKENS"],
};

describe("a deploy's plan", () => {
	it("installs fresh: the core, then the edge in front of it", () => {
		expect(planDeploy(nothing, { tokens: TOKENS })).toEqual([
			{ deploy: "core", space: "created" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("upgrades a 0.7 install, moving its spaces and its bucket into the core", () => {
		expect(planDeploy(from07, { tokens: TOKENS })).toEqual([
			{ deploy: "core", space: "expecting-transfer", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "transferred" },
			{ deploy: "core", space: "created", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("resumes an upgrade stopped after the core began expecting the spaces, without asking again", () => {
		const stopped: Observed = {
			...from07,
			coreExists: true,
			transferPending: true,
			coreFilesBucket: "loopback-files",
		};
		expect(planDeploy(stopped, { tokens: TOKENS })).toEqual([
			{ deploy: "edge", space: "transferred" },
			{ deploy: "core", space: "created", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("resumes an upgrade stopped after the edge handed the spaces over", () => {
		const stopped: Observed = {
			...on08,
			edgeFilesBucket: "loopback-files",
			edgeSecrets: ["LOOPBACK_TOKEN", "LOOPBACK_TOKENS"],
		};
		expect(planDeploy(stopped, {})).toEqual([
			{ deploy: "core", space: "created", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("deploys a 0.8 install again, keeping the core's bucket, with no secrets file", () => {
		expect(planDeploy(on08, {})).toEqual([
			{ deploy: "core", space: "created", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("keeps the bucket a fresh install's core was given", () => {
		const fresh08: Observed = { ...on08, coreFilesBucket: "loopback-core-files" };
		expect(planDeploy(fresh08, {})[0]).toEqual({
			deploy: "core",
			space: "created",
			filesBucket: "loopback-core-files",
		});
	});

	it("stops when both Workers hold the spaces, which no deploy leaves behind", () => {
		expect(() => planDeploy({ ...on08, edgeHoldsSpace: true }, { tokens: TOKENS })).toThrow(
			/Both loopback and loopback-core hold a Space namespace/,
		);
	});

	it("stops when the spaces' edge binds no bucket, rather than leave their images behind", () => {
		const { edgeFilesBucket: _, ...bucketless } = from07;
		expect(() => planDeploy(bucketless, { tokens: TOKENS })).toThrow(/binds no FILES bucket/);
	});

	it("names the Workers it reports by the deployment's name", () => {
		expect(() =>
			planDeploy({ ...on08, edgeHoldsSpace: true }, { tokens: TOKENS, name: "trial" }),
		).toThrow(/Both trial and trial-core/);
	});
});

describe("a deploy's tokens", () => {
	it("stops before deploying anything when the edge has none and none are given, as the gate would", () => {
		expect(() => planDeploy(nothing, {})).toThrow(/^LOOPBACK_TOKENS is not set\./);
	});

	it("says how to move from LOOPBACK_TOKEN, as the gate would", () => {
		expect(() => planDeploy(from07, {})).toThrow(
			'LOOPBACK_TOKEN is replaced by LOOPBACK_TOKENS: put your token in it as {"owner": "<token>"} and deploy again.',
		);
	});

	it("refuses tokens the gate would refuse, naming the person and never the token", () => {
		const shared = "5a4b3c2d1e0f5a4b3c2d1e0f5a4b3c2d1e0f";
		const refused = () =>
			planDeploy(nothing, { tokens: JSON.stringify({ ada: shared, owner: shared }) });
		expect(refused).toThrow(/"ada" and "owner" have the same token/);
		expect(refused).not.toThrow(new RegExp(shared));
	});

	it("takes new tokens over the edge's own", () => {
		expect(planDeploy(on08, { tokens: TOKENS })).toHaveLength(2);
	});
});
