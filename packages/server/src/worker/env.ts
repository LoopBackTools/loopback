import { Context } from "effect";

/** The bindings a Loopback Worker must declare, under these names. */
export interface LoopbackBindings {
	readonly FILES: R2Bucket;
	/**
	 * Which deploy the code is from. A space still running older code than the Worker calling it
	 * restarts onto the newer; without it, nothing is compared. Declare it in every deployment.
	 */
	readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

/**
 * The Worker's environment as the runtime hands it over: Loopback's bindings, and whatever else the
 * deployment declares, which a gate may read (the token gate reads `LOOPBACK_TOKEN`).
 */
export type WorkerBindings = LoopbackBindings & Readonly<Record<string, unknown>>;

export class WorkerEnv extends Context.Service<WorkerEnv, WorkerBindings>()("loopback/WorkerEnv") {}
