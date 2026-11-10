// The edge's tests run against the edge as the deployment exports it, beside the core it calls.
import { Core } from "@loopbacktools/core";
import { REVISION } from "@loopbacktools/protocol/schema";

export { default } from "../../src/edge/worker.ts";
export { Core, Space } from "@loopbacktools/core";

/** A core one revision behind the edge, as one is until `loopback-core` is deployed. */
export class OldCore extends Core {
	override async revision() {
		return REVISION - 1;
	}
}
