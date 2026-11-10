import {
	BOTH_GATES,
	JWT_REQUIRED,
	missingJwtSetting,
	NO_TOKENS,
	OLD_TOKEN,
	readTokens,
} from "../apps/loopback/src/edge/tokens.ts";

/**
 * What a deploy does, from what the account holds. Pure: `scripts/deploy.ts` observes, this decides.
 *
 * A deployment is two Workers, the core (`<name>-core`), which holds every space in its `Space`
 * Durable Object namespace and the images in its bucket, and the edge (`<name>`) in front of it.
 * A 0.7 install is one Worker, the edge, holding both. Upgrading one moves the namespace to the core
 * without copying it, in Cloudflare's two-phase transfer: the core declares it expects the edge's
 * `Space`, then the edge declares it transferred, which commits it, ids and data intact. The core
 * binds the edge's bucket by name; dropping it from the edge keeps the bucket.
 */

/** What the account holds of a deployment, as `scripts/deploy.ts` reads it. */
export interface Observed {
	/** A `Space` namespace belongs to the edge Worker: a 0.7 install, or one stopped before its move. */
	readonly edgeHoldsSpace: boolean;
	readonly coreExists: boolean;
	/** A `Space` namespace belongs to the core Worker. */
	readonly coreHoldsSpace: boolean;
	/** The core's current version is one this deploy uploaded expecting the edge's `Space`. */
	readonly transferPending: boolean;
	/** The bucket the edge's current version binds as `FILES`, if any: a 0.7 install's images. */
	readonly edgeFilesBucket?: string;
	/** The bucket the core's current version binds as `FILES`, if it exists. */
	readonly coreFilesBucket?: string;
	/** The names of the secrets the edge Worker has. */
	readonly edgeSecrets: readonly string[];
}

/** What the person deploying gave. */
export interface Given {
	/** The deployment's name: the edge's Worker, and `<name>-core`. `loopback` unless said otherwise. */
	readonly name?: string;
	/** `LOOPBACK_TOKENS` from the secrets file, when it carries it. */
	readonly tokens?: string;
	/**
	 * The JWT gate's settings, from the environment the deploy runs in, for an edge behind a login
	 * instead of tokens: `LOOPBACK_JWKS_URL` and the others, as `apps/loopback`'s config reads them.
	 */
	readonly jwt?: Readonly<Record<string, string | undefined>>;
}

/** One deploy of one Worker, with the state its `Space` export is declared in. */
export type Step =
	| {
			readonly deploy: "core";
			readonly space: "created" | "expecting-transfer";
			/** The bucket to bind as `FILES` by name; without one, the first deploy provisions its own. */
			readonly filesBucket?: string;
	  }
	| { readonly deploy: "edge"; readonly space: "none" | "transferred" };

/** A deploy that must not start, and why, in the words its person is told. */
export class Refused extends Error {
	override readonly name = "Refused";
}

/**
 * The steps that bring the account to a 0.8 deployment from whatever it holds, each safe to run
 * again: a run stopped at any step is finished by running the deploy again. Refuses before any step
 * when the edge would come up with no tokens the gate accepts, or when the account holds what no
 * deploy leaves behind.
 */
export const planDeploy = (observed: Observed, given: Given): readonly Step[] => {
	const name = given.name ?? "loopback";
	const jwt = given.jwt ?? {};
	const set = (setting: string) => (jwt[setting] ?? "") !== "";
	if (set("LOOPBACK_JWKS_URL")) {
		if (given.tokens !== undefined) throw new Refused(BOTH_GATES);
		if (observed.edgeSecrets.includes("LOOPBACK_TOKENS")) {
			throw new Refused(
				`${BOTH_GATES} ${name} still has LOOPBACK_TOKENS: delete it with \`cf workers secrets delete LOOPBACK_TOKENS --worker ${name}\` to move it behind your login.`,
			);
		}
		const missing = JWT_REQUIRED.find((setting) => !set(setting));
		if (missing !== undefined) throw new Refused(missingJwtSetting(missing));
	} else if (given.tokens !== undefined) {
		const tokens = readTokens(given.tokens);
		if ("problem" in tokens) throw new Refused(tokens.problem);
	} else if (!observed.edgeSecrets.includes("LOOPBACK_TOKENS")) {
		throw new Refused(observed.edgeSecrets.includes("LOOPBACK_TOKEN") ? OLD_TOKEN : NO_TOKENS);
	}

	// Mid-transfer, the core may list the namespace it expects beside the edge that still holds it.
	if (observed.edgeHoldsSpace && observed.coreHoldsSpace && !observed.transferPending) {
		throw new Refused(
			`Both ${name} and ${name}-core hold a Space namespace, which no deploy leaves behind. Stop, and report it with the output of \`cf durable-objects namespaces list\`.`,
		);
	}

	const filesBucket = observed.coreFilesBucket ?? observed.edgeFilesBucket;
	const core = (space: "created" | "expecting-transfer"): Step =>
		filesBucket === undefined ? { deploy: "core", space } : { deploy: "core", space, filesBucket };
	const finish: readonly Step[] = [core("created"), { deploy: "edge", space: "none" }];

	if (!observed.edgeHoldsSpace) return finish;
	if (observed.edgeFilesBucket === undefined && observed.coreFilesBucket === undefined) {
		throw new Refused(
			`${name} holds the spaces but binds no FILES bucket, so their images can't be found to move. Stop, and report it.`,
		);
	}
	const handOver: Step = { deploy: "edge", space: "transferred" };
	return observed.transferPending
		? [handOver, ...finish]
		: [core("expecting-transfer"), handOver, ...finish];
};

/**
 * Why a step must not run, read from the account just before it does, or nothing when it may: each
 * step's precondition, so a deploy that observed wrongly, or that something changed under, stops
 * rather than drops the spaces.
 */
export const refusalBefore = (step: Step, observed: Observed, name: string): string | undefined => {
	const stillHeld = `${name} still holds the spaces, so this step would leave them behind. Stop, and report it with the output of \`cf durable-objects namespaces list\`.`;
	if (step.deploy === "edge" && step.space === "none") {
		return observed.edgeHoldsSpace ? stillHeld : undefined;
	}
	if (step.deploy === "core" && step.space === "created") {
		return observed.edgeHoldsSpace ? stillHeld : undefined;
	}
	if (step.deploy === "edge") {
		return observed.edgeHoldsSpace && observed.transferPending
			? undefined
			: `${name}-core isn't expecting ${name}'s spaces, so handing them over would fail. Stop, and report it.`;
	}
	return observed.edgeHoldsSpace
		? undefined
		: `${name} holds no spaces for ${name}-core to expect. Stop, and report it.`;
};
