import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

/**
 * `--mode cpu-check` deploys a separate copy, `loopback-cpu-check`, held to Workers Free's 10 ms of
 * CPU per request, to check a change fits the free plan before it ships (scripts/cpu-check.ts drives
 * it). Delete it afterwards with `cf workers delete loopback-cpu-check`.
 */
const CPU_CHECK = "cpu-check";

export default defineConfig(({ mode }) => ({
	worker: {
		name: mode === CPU_CHECK ? "loopback-cpu-check" : "loopback",
		...(mode === CPU_CHECK ? { limits: { cpuMs: 10 } } : {}),
		entrypoint,
		compatibilityDate: "2026-10-19",
		// enable_request_signal: a request's signal aborts when its client goes away, so work for a
		// caller who has left is interrupted rather than finished for no one.
		compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
		observability: {
			enabled: true,
			logs: { headSamplingRate: 1 },
			traces: { enabled: true, headSamplingRate: 1 },
		},
		assets: {
			notFoundHandling: "single-page-application",
			// /.well-known/* too, so a client probing for OAuth metadata gets the Worker's 404, not the
			// inbox; and /llms.txt, which the Worker writes for the way this deployment's agents sign in.
			runWorkerFirst: ["/api/*", "/mcp", "/.well-known/*", "/llms.txt"],
		},
		env: {
			LOOPBACK_TOKEN: bindings.secret(),
			// No bucket name: the first deploy provisions one.
			FILES: bindings.r2(),
			// Which deploy the code is from: a space still on older code restarts onto newer.
			CF_VERSION_METADATA: bindings.versionMetadata(),
		},
		// The server reaches its spaces through the runtime's binding for this export, so no
		// Durable Object binding names this Worker, and a copy deployed under another name still works.
		exports: { Space: exports.durableObject({ storage: "sqlite" }) },
	},
}));
