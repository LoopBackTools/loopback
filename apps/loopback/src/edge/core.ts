import type { CoreRpc } from "@loopbacktools/core/rpc";
import { REVISION } from "@loopbacktools/protocol/schema";
import type { EdgeBindings } from "./env.ts";
import { NotConfigured } from "./problems.ts";

/** The deployment's core, or the setting that is missing when it has none. */
export const coreOf = (env: EdgeBindings): CoreRpc => {
	if (env.CORE === undefined) {
		throw new NotConfigured(
			"CORE is not bound: deploy loopback-core and bind it as CORE (entrypoint Core).",
		);
	}
	return env.CORE;
};

/** How often the edge asks an older core again, and how long it waits between: three tries over 3 s. */
const RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

const checked = new WeakMap<object, Promise<void>>();

/** Asks the core its revision until it is this edge's or later, as many times again as `retries`. */
const caughtUp = async (core: CoreRpc, retries: number): Promise<void> => {
	if ((await core.revision()) >= REVISION) return;
	if (retries === 0) {
		throw new NotConfigured(
			"This Loopback core is older than its edge: deploy loopback-core first.",
		);
	}
	await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
	return caughtUp(core, retries - 1);
};

/**
 * Resolves once the core speaks this edge's revision of the contract or a later one, which it is
 * asked once per isolate. A core still on an older revision is asked again three times over three
 * seconds, as a deploy of both lands, and then refused with what to do: the edge would otherwise send
 * it messages it can't read. A refusal is not kept, so the next request asks again.
 */
export const ready = (core: CoreRpc): Promise<void> => {
	let check = checked.get(core);
	if (check === undefined) {
		check = caughtUp(core, RETRIES);
		checked.set(core, check);
		check.catch(() => checked.delete(core));
	}
	return check;
};
