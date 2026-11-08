// The Worker the core's tests run against: the core as a deployment composes it, called by tests
// through a service binding to its own `Core` entrypoint, so every call crosses a real binding.
import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const name = "loopback-core-test";

export default defineConfig({
	worker: {
		name,
		entrypoint,
		compatibilityDate: "2026-10-19",
		compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
		env: {
			FILES: bindings.r2({ name }),
			// Which deploy the code is from, which a space compares with its caller's.
			CF_VERSION_METADATA: bindings.versionMetadata(),
			// The core as an edge reaches it: a service binding to its own entrypoint.
			CORE: bindings.worker({ worker: name, exportName: "Core" }),
			// The core as dispatch reaches it: its default export, which takes no entrypoint.
			CORE_DEFAULT: bindings.worker({ worker: name }),
		},
		exports: { Space: exports.durableObject({ storage: "sqlite" }) },
	},
});
