/**
 * CPU per request at a deployment, from Workers observability, grouped by MCP method (or by route
 * for the HTTP API, and by event for the Durable Object). Run it after scripts/cpu-check.ts, with
 * the time the check started:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... node scripts/cpu-report.ts loopback-cpu-check 2026-11-07T17:00:00Z
 *
 * It reads the events with `cf o11y telemetry query`, so `cf` must be signed in to the account.
 * Logs arrive a minute or so after the requests: run it once the check has been done that long.
 */
import { execFileSync } from "node:child_process";

const [worker, since] = process.argv.slice(2);
if (worker === undefined || since === undefined || Number.isNaN(Date.parse(since))) {
	console.error("usage: node scripts/cpu-report.ts <worker name> <ISO time the check started>");
	process.exit(2);
}

interface Invocation {
	readonly cpuTimeMs?: number;
	readonly wallTimeMs?: number;
	readonly outcome?: string;
	readonly executionModel?: string;
	readonly eventType?: string;
	readonly event?: {
		readonly request?: {
			readonly method?: string;
			readonly url?: string;
			readonly headers?: Record<string, string>;
		};
	};
}

const out = execFileSync(
	"cf",
	[
		"o11y",
		"telemetry",
		"query",
		"--query-id",
		`cpu-report-${Date.now()}`,
		"--view",
		"events",
		"--limit",
		"2000",
		"--timeframe-from",
		String(Date.parse(since)),
		"--timeframe-to",
		String(Date.now()),
		"--parameters-filters",
		JSON.stringify([{ key: "$metadata.service", operation: "eq", type: "string", value: worker }]),
		"--parameters-order-by-value",
		"timestamp",
	],
	{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
const events = (
	JSON.parse(out) as {
		readonly events: { readonly events: ReadonlyArray<{ readonly $workers?: Invocation }> };
	}
).events.events;

/** What a request was: its MCP method, or its route with ids left out, or the object's event. */
const kindOf = (invocation: Invocation): string => {
	if (invocation.executionModel === "durableObject") return `DO ${invocation.eventType}`;
	const request = invocation.event?.request;
	const method = request?.headers?.["mcp-method"];
	if (method !== undefined) return method;
	const path = new URL(request?.url ?? "http://unknown/").pathname
		.replace(/\/asks\/[^/]+/, "/asks/:id")
		.replace(/\/uploads\/.+/, "/uploads/:space/:token")
		.replace(/\/files\/.+/, "/files/:id");
	return `${request?.method ?? "?"} ${path}`;
};

const groups = new Map<string, { cpu: number[]; wall: number[]; over: number; killed: number }>();
for (const { $workers: invocation } of events) {
	if (invocation?.cpuTimeMs === undefined) continue;
	const kind = kindOf(invocation);
	const group = groups.get(kind) ?? { cpu: [], wall: [], over: 0, killed: 0 };
	group.cpu.push(invocation.cpuTimeMs);
	group.wall.push(invocation.wallTimeMs ?? 0);
	if (invocation.cpuTimeMs > 10) group.over += 1;
	if (invocation.outcome === "exceededCpu") group.killed += 1;
	groups.set(kind, group);
}

const percentile = (values: readonly number[], p: number): number => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] ?? 0;
};

console.log(
	["request", "n", "median", "p90", "p99", "max", "over 10 ms", "exceededCpu", "wall max"].join(
		"\t",
	),
);
for (const [kind, group] of [...groups].toSorted(
	(a, b) => Math.max(...b[1].cpu) - Math.max(...a[1].cpu),
)) {
	console.log(
		[
			kind,
			group.cpu.length,
			percentile(group.cpu, 50),
			percentile(group.cpu, 90),
			percentile(group.cpu, 99),
			Math.max(...group.cpu),
			group.over,
			group.killed,
			Math.max(...group.wall),
		].join("\t"),
	);
}
