// The Worker the edge's tests run against: the edge and the core in one Worker, the edge reaching the
// core through a service binding to this Worker's own `Core` entrypoint, so every call crosses a real
// binding as it does between the two deployed Workers.
import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const name = "loopback-edge-test";

export default defineConfig({
	worker: {
		name,
		entrypoint,
		compatibilityDate: "2026-10-19",
		compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
		env: {
			// The core's.
			FILES: bindings.r2({ name }),
			// Which deploy the code is from: the edge names it on every answer.
			CF_VERSION_METADATA: bindings.versionMetadata(),
			CORE: bindings.worker({ worker: name, exportName: "Core" }),
			// A core one revision behind the edge, as one not yet deployed is.
			OLD_CORE: bindings.worker({ worker: name, exportName: "OldCore" }),
			LOOPBACK_TOKENS: bindings.text(
				JSON.stringify({
					owner: "owner-token-0123456789abcdef0123456789abcdef",
					ada: "ada-token-0123456789abcdef0123456789abcdef01",
				}),
			),
			LOOPBACK_PLAN: bindings.text("free"),
		},
		exports: { Space: exports.durableObject({ storage: "sqlite" }) },
	},
});
