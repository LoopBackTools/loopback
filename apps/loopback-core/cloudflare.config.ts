import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

/**
 * The core Worker, `<LOOPBACK_NAME>-core`: every space and its images, reached only by its edge
 * through a service binding. It has no public address: with `Core` as its default export, a route
 * would answer anyone's socket upgrade. Deploy it with `pnpm run deploy` at the root, which sets:
 *
 * - `LOOPBACK_CORE_SPACE`: `expecting-transfer` while it takes over a 0.7 edge's `Space` namespace,
 *   `created` (the default) otherwise;
 * - `LOOPBACK_FILES_BUCKET`: the bucket it binds as `FILES`, kept from deploy to deploy: a 0.7
 *   install's own, or the one its first deploy provisioned.
 */
const name = process.env["LOOPBACK_NAME"] || "loopback";
const bucket = process.env["LOOPBACK_FILES_BUCKET"];

const space =
	process.env["LOOPBACK_CORE_SPACE"] === "expecting-transfer"
		? exports.durableObject({ state: "expecting-transfer", transferFrom: name, storage: "sqlite" })
		: exports.durableObject({ storage: "sqlite" });

export default defineConfig({
	worker: {
		name: `${name}-core`,
		entrypoint,
		compatibilityDate: "2026-10-19",
		compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
		workersDev: false,
		previewUrls: false,
		observability: {
			enabled: true,
			logs: { headSamplingRate: 1 },
			traces: { enabled: true, headSamplingRate: 1 },
		},
		env: {
			FILES: bucket === undefined || bucket === "" ? bindings.r2() : bindings.r2({ name: bucket }),
			// Which deploy the code is from: a space still on older code restarts onto newer.
			CF_VERSION_METADATA: bindings.versionMetadata(),
		},
		// The core reaches its spaces through the runtime's binding for this export, so no Durable
		// Object binding names this Worker.
		exports: { Space: space },
	},
});
