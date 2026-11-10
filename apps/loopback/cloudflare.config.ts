import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };
import { planFrom, planNotice } from "./plan.ts";

/**
 * `--mode cpu-check` deploys a separate copy, `<name>-cpu-check`, held to Workers Free's 10 ms of
 * CPU per request, to check a change fits the free plan before it ships (scripts/cpu-check.ts drives
 * it). Delete it afterwards with `cf workers delete loopback-cpu-check`.
 */
const CPU_CHECK = "cpu-check";

/**
 * The Workers plan the deployment runs on, from `LOOPBACK_PLAN` when it is deployed (./plan.ts):
 * `paid` lets a blocking call wait until the reply; anything else fits Workers Free's 10 ms of CPU
 * per request (see "Free or Paid" in the README). The CPU check is always for Free. A deploy that
 * falls back to Free says so.
 */
const plan = (mode: string | undefined) => {
	if (mode === CPU_CHECK) return "free";
	const notice = mode === "development" ? undefined : planNotice(process.env["LOOPBACK_PLAN"]);
	if (notice !== undefined) console.warn(notice);
	return planFrom(process.env["LOOPBACK_PLAN"]);
};

/**
 * The deployment's name: this Worker's, and its core's, `<name>-core`. Deploy both with
 * `pnpm run deploy` at the root, which sets `LOOPBACK_EDGE_SPACE` to `transferred` for the one deploy
 * that hands a 0.7 install's spaces to the core.
 */
const name = process.env["LOOPBACK_NAME"] || "loopback";

/**
 * The `Space` namespace this Worker held before 0.8, declared handed over to the core for the deploy
 * that moves it, and gone after: the edge holds no spaces.
 */
const transferred =
	process.env["LOOPBACK_EDGE_SPACE"] === "transferred"
		? { Space: exports.durableObject({ state: "transferred", transferredTo: `${name}-core` }) }
		: undefined;

/**
 * Who may use this Loopback. Tokens, `LOOPBACK_TOKENS`, unless the deploy's environment sets
 * `LOOPBACK_JWKS_URL`: then the JWT gate's settings, read from that environment on every deploy, as
 * `LOOPBACK_PLAN` is. None of them is a secret.
 */
const JWT_SETTINGS = [
	"LOOPBACK_JWKS_URL",
	"LOOPBACK_JWT_ISSUER",
	"LOOPBACK_JWT_AUDIENCE",
	"LOOPBACK_SPACE_CLAIM",
	"LOOPBACK_NAME_CLAIM",
] as const;
const gate = process.env["LOOPBACK_JWKS_URL"]
	? Object.fromEntries(
			JWT_SETTINGS.flatMap((setting) => {
				const value = process.env[setting];
				return value === undefined || value === "" ? [] : [[setting, bindings.text(value)]];
			}),
		)
	: { LOOPBACK_TOKENS: bindings.secret() };

export default defineConfig(({ mode }) => ({
	worker: {
		name: mode === CPU_CHECK ? `${name}-cpu-check` : name,
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
			// The core, which holds every space and its images: deployed first, as loopback-core.
			CORE: bindings.worker({ worker: `${name}-core`, exportName: "Core" }),
			// Who may use this Loopback: {"<person>": "<token>"}, each token from `openssl rand -hex 32`,
			// or the JWT gate's settings.
			...gate,
			LOOPBACK_PLAN: bindings.text(plan(mode)),
			// Which deploy the edge is from, which it names on every answer.
			CF_VERSION_METADATA: bindings.versionMetadata(),
		},
		...(transferred === undefined ? {} : { exports: transferred }),
	},
}));
