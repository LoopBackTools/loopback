/**
 * Drives the MCP traffic an agent sends, at a deployment, so its CPU per request can be read back
 * from Workers observability (scripts/cpu-report.md). Run it against a copy deployed with
 * `pnpm run deploy --mode cpu-check`, which is held to Workers Free's 10 ms of CPU per request:
 *
 *   LOOPBACK_URL=https://loopback-cpu-check.<subdomain>.workers.dev LOOPBACK_TOKEN=... \
 *     node scripts/cpu-check.ts
 *
 * Every request names its MCP method in `Mcp-Method`, which the report groups by. It takes about
 * two minutes: one blocking question waits 90 seconds for its answer, or `CPU_CHECK_WAIT_MS`.
 */

// oxlint-disable no-await-in-loop -- the check sends one request after another, paced as an agent's.

const url = process.env["LOOPBACK_URL"]?.replace(/\/$/, "");
const token = process.env["LOOPBACK_TOKEN"];
if (url === undefined || token === undefined) {
	console.error("Set LOOPBACK_URL and LOOPBACK_TOKEN.");
	process.exit(2);
}

const TASKS = "io.modelcontextprotocol/tasks";
/** How long the blocking question waits for its answer: longer waits show the CPU each lap costs. */
const BLOCKING_WAIT_MS = Number(process.env["CPU_CHECK_WAIT_MS"] ?? 90_000);
const auth = { Authorization: `Bearer ${token}` };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Message {
	readonly id?: number;
	readonly method?: string;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string };
}

let nextId = 1;

/** One 2026-07-28 request, read to the end of its response, with every message it carried. */
const rpc = async (
	method: string,
	params: Record<string, unknown>,
	options: { readonly name?: string; readonly tasks?: boolean; readonly progress?: boolean } = {},
): Promise<{
	readonly answer: Message | undefined;
	readonly messages: Message[];
	readonly ms: number;
}> => {
	const id = nextId++;
	const started = Date.now();
	const response = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			...auth,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": method,
			...(options.name === undefined ? {} : { "Mcp-Name": options.name }),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					...(options.progress === true ? { progressToken: id } : {}),
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "cpu-check", version: "1.0.0" },
					"io.modelcontextprotocol/clientCapabilities":
						options.tasks === true ? { extensions: { [TASKS]: {} } } : {},
				},
			},
		}),
	});
	const body = await response.text();
	const messages = (
		body.startsWith("{")
			? [body]
			: body
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
	).map((frame) => JSON.parse(frame) as Message);
	return {
		answer: messages.find((message) => message.id === id),
		messages,
		ms: Date.now() - started,
	};
};

const api = (path: string, init: RequestInit = {}) => {
	const headers = new Headers(init.headers);
	headers.set("Authorization", auth.Authorization);
	return fetch(`${url}/api/v1${path}`, { ...init, headers });
};

const reply = (askId: string, text: string) =>
	api(`/asks/${askId}/reply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "answered", selected: [], text }),
	});

/** The open ask whose question is `question`, once it appears. */
const openAsk = async (question: string): Promise<string> => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const snapshot = (await (await api("/snapshot")).json()) as {
			readonly open: ReadonlyArray<{
				readonly id: string;
				readonly prompt: { readonly question?: string };
			}>;
		};
		const found = snapshot.open.find((ask) => ask.prompt.question === question);
		if (found !== undefined) return found.id;
		await pause(200);
	}
	throw new Error(`The ask "${question}" never opened.`);
};

const run = Date.now().toString(36);
const report = (line: string) => console.log(`${new Date().toISOString()}  ${line}`);

report(`server/discover: ${(await rpc("server/discover", {})).ms} ms`);

for (let i = 0; i < 20; i += 1) await rpc("tools/list", {});
report("tools/list ×20: done");

const listen = await rpc("subscriptions/listen", { notifications: { toolsListChanged: true } });
report(`subscriptions/listen: closed after ${listen.ms} ms, ${listen.messages.length} frames`);

// A background task, polled at the interval it asks for, answered after 20 seconds.
const taskQuestion = `CPU check task ${run}?`;
const started = await rpc(
	"tools/call",
	{ name: "ask_question", arguments: { question: taskQuestion, project: "cpu-check" } },
	{ name: "ask_question", tasks: true },
);
const taskId = String(started.answer?.result?.["taskId"]);
const answerAt = Date.now() + 20_000;
let polls = 0;
let answered = false;
for (;;) {
	const polled = await rpc("tasks/get", { taskId }, { name: taskId, tasks: true });
	polls += 1;
	const status = polled.answer?.result?.["status"];
	if (status === "completed" || status === "cancelled") break;
	if (!answered && Date.now() >= answerAt) {
		await reply(taskId.slice(0, taskId.lastIndexOf(":")), "Answered by the CPU check.");
		answered = true;
	}
	await pause(Number(polled.answer?.result?.["pollIntervalMs"] ?? 2_000));
}
report(`task: completed after ${polls} polls`);

// A blocking question, answered after 90 seconds.
const blockingQuestion = `CPU check wait ${run}?`;
const blocking = rpc(
	"tools/call",
	{ name: "ask_question", arguments: { question: blockingQuestion, project: "cpu-check" } },
	{ name: "ask_question", progress: true },
);
const blockingAsk = await openAsk(blockingQuestion);
await pause(BLOCKING_WAIT_MS);
await reply(blockingAsk, "Answered by the CPU check.");
const waited = await blocking;
report(
	`blocking wait: ${waited.ms} ms, ${waited.messages.length - 1} progress frames, ${waited.answer?.error === undefined ? "answered" : `error ${waited.answer.error.message}`}`,
);

// One image upload: a 1×1 PNG.
const ticketCall = await rpc(
	"tools/call",
	{ name: "create_image_upload", arguments: { contentType: "image/png" } },
	{ name: "create_image_upload" },
);
const ticket = ticketCall.answer?.result?.["structuredContent"] as { readonly uploadUrl: string };
const png = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);
const put = await fetch(ticket.uploadUrl, {
	method: "PUT",
	headers: { "Content-Type": "image/png" },
	body: png,
});
report(`upload: HTTP ${put.status}`);
