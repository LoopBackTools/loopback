import { NO_TOKENS, OLD_TOKEN, readTokens } from "../apps/loopback/src/edge/tokens.ts";

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
	if (given.tokens !== undefined) {
		const tokens = readTokens(given.tokens);
		if ("problem" in tokens) throw new Refused(tokens.problem);
	} else if (!observed.edgeSecrets.includes("LOOPBACK_TOKENS")) {
		throw new Refused(observed.edgeSecrets.includes("LOOPBACK_TOKEN") ? OLD_TOKEN : NO_TOKENS);
	}

	if (observed.edgeHoldsSpace && observed.coreHoldsSpace) {
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
