/**
 * Deploys Loopback as two Workers: the core, `<name>-core`, then the edge, `<name>`, in front of it.
 * It installs fresh, upgrades a 0.7 install by moving its spaces and images into the core, or deploys
 * both again; a run stopped anywhere is finished by running it again.
 *
 *     pnpm run deploy [--dry-run] [--secrets-file <file>]
 *
 * Settings come from the environment: `LOOPBACK_NAME` (`loopback` unless set), `LOOPBACK_PLAN`
 * (`paid` on Workers Paid) and `CLOUDFLARE_ACCOUNT_ID`, as `cf` reads them. The secrets file, JSON or
 * dotenv, holds `LOOPBACK_TOKENS`; it is needed until the edge has tokens, and goes to the edge only.
 *
 * What it reads, through `cf`'s API commands:
 * - `cf durable-objects namespaces list`: which Worker holds the `Space` namespace;
 * - `cf workers deployments list --worker <name>`, then `cf workers versions get --worker-id <name>
 *   <version>`: each Worker's current version, the bucket it binds as `FILES`, and the tag this
 *   script gave it, which says a core was deployed expecting the edge's spaces;
 * - `cf workers secrets list --worker <name>`: which secrets the edge has.
 *
 * It prints the plan (`scripts/deploy-plan.ts`) and, under `--dry-run`, stops there. Otherwise it
 * runs each step as `cf deploy` in `apps/loopback-core` or `apps/loopback`, stopping at the first that
 * fails, then reads the account again and checks the core holds the spaces and the edge doesn't.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	filesBucketOf,
	type Observed,
	planDeploy,
	Refused,
	refusalBefore,
	type Step,
	tagOfVersion,
} from "./deploy-plan.ts";

const root = resolve(import.meta.dirname, "..");
const EDGE_DIR = join(root, "apps/loopback");
const CORE_DIR = join(root, "apps/loopback-core");
const CF = join(EDGE_DIR, "node_modules/.bin/cf");

/** The tag a step's version carries, which the next run reads back. */
const tagOf = (step: Step) => `${step.deploy}-space-${step.space}`;
const EXPECTING = tagOf({ deploy: "core", space: "expecting-transfer" });

class Failed extends Error {
	override readonly name = "Failed";
}

const argument = (flag: string): string | undefined => {
	const at = process.argv.indexOf(flag);
	if (at === -1) return undefined;
	const value = process.argv[at + 1];
	if (value === undefined || value.startsWith("--")) throw new Failed(`${flag} needs a value.`);
	return value;
};

/**
 * Runs `cf` with these arguments and reads what it prints as JSON. A read about one Worker answers
 * `undefined` when that Worker doesn't exist; any other failure stops the deploy, since reading
 * nothing where something is would plan the spaces away.
 */
const cf = (args: readonly string[], about: "account" | "worker" = "account"): unknown => {
	const run = spawnSync(CF, args, { cwd: EDGE_DIR, encoding: "utf8", env: process.env });
	const said = `${run.stdout}${run.stderr}`;
	if (run.status !== 0) {
		if (about === "worker" && /\b10007\b|does not exist|not found/i.test(said)) return undefined;
		throw new Failed(`\`cf ${args.join(" ")}\` failed:\n${said}`);
	}
	try {
		const parsed: unknown = JSON.parse(run.stdout);
		return typeof parsed === "object" && parsed !== null && "result" in parsed
			? (parsed as { readonly result: unknown }).result
			: parsed;
	} catch {
		throw new Failed(`\`cf ${args.join(" ")}\` printed something other than JSON:\n${said}`);
	}
};

const records = (value: unknown, key?: string): readonly Record<string, unknown>[] => {
	const list =
		key !== undefined && typeof value === "object" && value !== null && key in value
			? (value as Record<string, unknown>)[key]
			: value;
	return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};

/** A Worker's current version: the one its latest deployment sends all its traffic to. */
const currentVersion = (worker: string): Record<string, unknown> | undefined => {
	const deployments = records(
		cf(["workers", "deployments", "list", "--worker", worker], "worker"),
		"deployments",
	);
	const latest = deployments.toSorted((a, b) =>
		String(b["created_on"]).localeCompare(String(a["created_on"])),
	)[0];
	const versionId = records(latest?.["versions"])[0]?.["version_id"];
	if (typeof versionId !== "string") return undefined;
	const version = cf(["workers", "versions", "get", "--worker-id", worker, versionId], "worker");
	return typeof version === "object" && version !== null
		? (version as Record<string, unknown>)
		: undefined;
};

/** What the account holds of the deployment named `name`. */
const observe = (name: string): Observed => {
	const core = `${name}-core`;
	const spaces = records(
		cf(["durable-objects", "namespaces", "list", "--per-page", "1000"]),
	).filter((namespace) => namespace["class"] === "Space");
	const holds = (worker: string) => spaces.some((namespace) => namespace["script"] === worker);
	const edgeVersion = currentVersion(name);
	const coreVersion = currentVersion(core);
	const edgeHoldsSpace = holds(name);
	const edgeFilesBucket = filesBucketOf(edgeVersion);
	const coreFilesBucket = filesBucketOf(coreVersion);
	return {
		edgeHoldsSpace,
		coreExists: coreVersion !== undefined,
		coreHoldsSpace: holds(core),
		transferPending: edgeHoldsSpace && tagOfVersion(coreVersion) === EXPECTING,
		...(edgeFilesBucket === undefined ? {} : { edgeFilesBucket }),
		...(coreFilesBucket === undefined ? {} : { coreFilesBucket }),
		edgeSecrets: records(cf(["workers", "secrets", "list", "--worker", name], "worker")).flatMap(
			(secret) => (typeof secret["name"] === "string" ? [secret["name"]] : []),
		),
	};
};

/**
 * `LOOPBACK_TOKENS` as the secrets file gives it, as `cf deploy` reads the file: JSON, or dotenv,
 * where the process's own environment wins.
 */
const tokensIn = (file: string | undefined): string | undefined => {
	const fromEnvironment = process.env["LOOPBACK_TOKENS"];
	if (file === undefined) return undefined;
	if (fromEnvironment !== undefined) return fromEnvironment;
	const text = readFileSync(file, "utf8");
	if (text.trimStart().startsWith("{")) {
		const value = (JSON.parse(text) as Record<string, unknown>)["LOOPBACK_TOKENS"];
		return typeof value === "string" ? value : undefined;
	}
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?LOOPBACK_TOKENS\s*=\s*(.*?)\s*$/.exec(line);
		if (match?.[1] === undefined) continue;
		const value = match[1];
		const quoted = /^(["'])(.*)\1$/.exec(value);
		return quoted?.[2] === undefined
			? value
			: quoted[1] === '"'
				? quoted[2].replaceAll('\\"', '"')
				: quoted[2];
	}
	return undefined;
};

const describe = (step: Step) =>
	step.deploy === "core"
		? `deploy the core, its spaces ${step.space}${step.filesBucket === undefined ? "" : `, binding the bucket ${step.filesBucket}`}`
		: `deploy the edge, ${step.space === "transferred" ? "handing its spaces to the core" : "holding no spaces"}`;

/** Runs one step as `cf deploy` in its Worker's folder. */
const run = (step: Step, name: string, secretsFile: string | undefined) => {
	const env: NodeJS.ProcessEnv = { ...process.env, LOOPBACK_NAME: name };
	const args = ["deploy", "--tag", tagOf(step)];
	if (step.deploy === "core") {
		env["LOOPBACK_CORE_SPACE"] = step.space;
		if (step.filesBucket !== undefined) env["LOOPBACK_FILES_BUCKET"] = step.filesBucket;
	} else {
		env["LOOPBACK_EDGE_SPACE"] = step.space;
		if (secretsFile !== undefined) args.push("--secrets-file", resolve(secretsFile));
	}
	const done = spawnSync(CF, args, {
		cwd: step.deploy === "core" ? CORE_DIR : EDGE_DIR,
		env,
		stdio: "inherit",
	});
	if (done.status !== 0) {
		throw new Failed(
			`Stopped: \`cf deploy\` failed to ${describe(step)}. Run the deploy again to carry on.`,
		);
	}
};

const main = () => {
	const name = process.env["LOOPBACK_NAME"] || "loopback";
	const dryRun = process.argv.includes("--dry-run");
	const secretsFile = argument("--secrets-file");
	const tokens = tokensIn(secretsFile);

	const observed = observe(name);
	console.log(`What the account holds of ${name}:`, observed);
	const jwt = Object.fromEntries(
		[
			"LOOPBACK_JWKS_URL",
			"LOOPBACK_JWT_ISSUER",
			"LOOPBACK_JWT_AUDIENCE",
			"LOOPBACK_SPACE_CLAIM",
			"LOOPBACK_NAME_CLAIM",
		].map((setting) => [setting, process.env[setting]]),
	);
	const steps = planDeploy(observed, { name, jwt, ...(tokens === undefined ? {} : { tokens }) });
	console.log("The plan:");
	for (const [index, step] of steps.entries()) console.log(`  ${index + 1}. ${describe(step)}`);
	if (dryRun) return;

	const generated = spawnSync("pnpm", ["generate"], { cwd: root, stdio: "inherit" });
	if (generated.status !== 0) throw new Failed("Stopped: `pnpm generate` failed.");
	// Each step is checked against the account as it stands just before it runs, not as it was planned.
	for (const [index, step] of steps.entries()) {
		const refusal = refusalBefore(step, index === 0 ? observed : observe(name), name);
		if (refusal !== undefined) throw new Failed(`Stopped before step ${index + 1}: ${refusal}`);
		run(step, name, secretsFile);
	}

	const after = observe(name);
	const wrong = !after.coreHoldsSpace
		? `${name}-core doesn't hold the spaces`
		: after.edgeHoldsSpace
			? `${name} still holds the spaces`
			: undefined;
	if (wrong !== undefined) {
		throw new Failed(
			`The deploy ran, but ${wrong}: ${JSON.stringify(after)}. Stop, and report it.`,
		);
	}
	console.log(`Deployed: ${name}-core holds the spaces, and ${name} is in front of it.`);
};

try {
	main();
} catch (error) {
	if (error instanceof Refused || error instanceof Failed) {
		console.error(error.message);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
