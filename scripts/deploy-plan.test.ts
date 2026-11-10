import { describe, expect, it } from "vitest";
import { type Observed, planDeploy, refusalBefore } from "./deploy-plan.ts";

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

	it("resumes when the core lists the spaces it expects beside the edge, mid-transfer", () => {
		const midTransfer: Observed = {
			...from07,
			coreExists: true,
			coreHoldsSpace: true,
			transferPending: true,
			coreFilesBucket: "loopback-files",
		};
		expect(planDeploy(midTransfer, { tokens: TOKENS })).toEqual([
			{ deploy: "edge", space: "transferred" },
			{ deploy: "core", space: "created", filesBucket: "loopback-files" },
			{ deploy: "edge", space: "none" },
		]);
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

describe("a JWT-gated deploy", () => {
	const jwt = {
		LOOPBACK_JWKS_URL: "https://login.example.com/.well-known/jwks.json",
		LOOPBACK_JWT_ISSUER: "https://login.example.com",
		LOOPBACK_JWT_AUDIENCE: "https://loopback.example.com/mcp",
		LOOPBACK_SPACE_CLAIM: "org_id",
	};

	it("needs no tokens", () => {
		expect(planDeploy(nothing, { jwt })).toEqual([
			{ deploy: "core", space: "created" },
			{ deploy: "edge", space: "none" },
		]);
	});

	it("names a setting the gate would need, as the gate would", () => {
		const { LOOPBACK_JWT_ISSUER: _, ...incomplete } = jwt;
		expect(() => planDeploy(nothing, { jwt: incomplete })).toThrow(
			"LOOPBACK_JWT_ISSUER is not set; a JWT-gated deployment needs it.",
		);
	});

	it("refuses tokens beside it, as the gate would", () => {
		expect(() => planDeploy(nothing, { jwt, tokens: TOKENS })).toThrow(
			/^Both LOOPBACK_TOKENS and LOOPBACK_JWKS_URL are set\./,
		);
		expect(() => planDeploy(on08, { jwt })).toThrow(
			/^Both LOOPBACK_TOKENS and LOOPBACK_JWKS_URL are set\..*cf workers secrets delete/s,
		);
	});
});

describe("each step, checked against the account just before it runs", () => {
	it("never deploys the edge without its spaces while it still holds them", () => {
		expect(refusalBefore({ deploy: "edge", space: "none" }, from07, "loopback")).toMatch(
			/loopback still holds the spaces/,
		);
		expect(refusalBefore({ deploy: "edge", space: "none" }, on08, "loopback")).toBeUndefined();
	});

	it("never creates the core's spaces while the edge still holds them", () => {
		expect(refusalBefore({ deploy: "core", space: "created" }, from07, "loopback")).toMatch(
			/loopback still holds the spaces/,
		);
		expect(
			refusalBefore({ deploy: "core", space: "created" }, nothing, "loopback"),
		).toBeUndefined();
	});

	it("hands the spaces over only once the core expects them", () => {
		const handOver = { deploy: "edge", space: "transferred" } as const;
		expect(refusalBefore(handOver, from07, "loopback")).toMatch(/loopback-core isn't expecting/);
		expect(
			refusalBefore(handOver, { ...from07, coreExists: true, transferPending: true }, "loopback"),
		).toBeUndefined();
	});

	it("asks the core to expect the spaces only while the edge holds them", () => {
		const expecting = {
			deploy: "core",
			space: "expecting-transfer",
			filesBucket: "loopback-files",
		} as const;
		expect(refusalBefore(expecting, on08, "loopback")).toMatch(/loopback holds no spaces/);
		expect(refusalBefore(expecting, from07, "loopback")).toBeUndefined();
	});
});
