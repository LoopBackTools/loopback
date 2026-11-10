import type { CoreRpc } from "@loopbacktools/core/rpc";

/** The bindings and settings the edge reads, under these names. */
export interface EdgeBindings {
	/**
	 * The core: a service binding to the `Core` entrypoint of the deployment's core Worker. An edge
	 * without one answers every request with a 500 that says so.
	 */
	readonly CORE?: CoreRpc;
	/** Who may use this Loopback: a JSON object from each person's id to their token. */
	readonly LOOPBACK_TOKENS?: string;
	/** The one token an edge took before `LOOPBACK_TOKENS`, read only to say how to move off it. */
	readonly LOOPBACK_TOKEN?: string;
	/** The JWT gate's settings, for a space per tenant behind a login of the deployment's own. */
	readonly LOOPBACK_JWKS_URL?: string;
	readonly LOOPBACK_JWT_ISSUER?: string;
	readonly LOOPBACK_JWT_AUDIENCE?: string;
	readonly LOOPBACK_SPACE_CLAIM?: string;
	readonly LOOPBACK_NAME_CLAIM?: string;
	/** `paid` on Workers Paid, where a blocking call waits until the reply; anything else is Free. */
	readonly LOOPBACK_PLAN?: string;
	/** Which deploy the edge is from, which it names on every answer. */
	readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

/** The edge's build, from its version metadata, if it has any. */
export const buildOf = (env: EdgeBindings): string | undefined =>
	env.CF_VERSION_METADATA?.timestamp;
