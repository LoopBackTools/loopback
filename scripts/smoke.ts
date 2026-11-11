/**
 * Checks a deployed Loopback end to end, through its own URL, as an agent and an inbox reach it.
 *
 *     node scripts/smoke.ts <edge-origin> <token> [--existing <askId>]
 *
 * It stops at the first check that fails, with a non-zero exit. What it opens it closes: each ask is
 * answered or dismissed. With `--existing`, it also reads that ask, and the first image it shows,
 * which is how an upgrade proves what was there before survived it.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [origin, token] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const existingAt = process.argv.indexOf("--existing");
const existing = existingAt === -1 ? undefined : process.argv[existingAt + 1];
if (origin === undefined || token === undefined || (existingAt !== -1 && existing === undefined)) {
	console.error("Usage: node scripts/smoke.ts <edge-origin> <token> [--existing <askId>]");
	process.exit(2);
}
const api = `${origin}/api/v1`;
const auth = { Authorization: `Bearer ${token}` };
const project = "loopback-smoke";

const check = async (what: string, test: () => Promise<string | void>) => {
	const started = Date.now();
	try {
		const said = await test();
		console.log(
			`ok   ${what} (${Date.now() - started} ms)${said === undefined ? "" : `: ${said}`}`,
		);
	} catch (error) {
		console.error(`FAIL ${what}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
};

const expect = (condition: boolean, message: string) => {
	if (!condition) throw new Error(message);
};

const json = async (response: Response) => {
	const text = await response.text();
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`${response.status}, not JSON: ${text.slice(0, 200)}`);
	}
};

/** The open ask whose question is `text`, once it appears: looked for every 200 ms, fifty times. */
const openAsk = async (text: string, tries = 50): Promise<string> => {
	const snapshot = await json(await fetch(`${api}/snapshot`, { headers: auth }));
	const open = snapshot["open"] as { id: string; prompt: { question?: string } }[];
	const found = open.find((ask) => ask.prompt.question === text);
	if (found !== undefined) return found.id;
	if (tries === 0) throw new Error(`The ask "${text}" never opened.`);
	await new Promise((resolve) => setTimeout(resolve, 200));
	return openAsk(text, tries - 1);
};

const reply = async (askId: string, body: unknown) => {
	const response = await fetch(`${api}/asks/${askId}/reply`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.status === 200, `the reply was answered ${response.status}`);
};

/** A 1 KB PNG: the signature, then filler. */
const png = new Uint8Array(1024);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (let index = 8; index < png.length; index += 1) png[index] = index % 251;

await check("GET /llms.txt answers 200 text/plain", async () => {
	const response = await fetch(`${origin}/llms.txt`);
	expect(response.status === 200, `status ${response.status}`);
	expect(
		(response.headers.get("Content-Type") ?? "").startsWith("text/plain"),
		`Content-Type ${response.headers.get("Content-Type")}`,
	);
});

await check("/mcp refuses a request without a token, with a challenge", async () => {
	const response = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
	expect(response.status === 401, `status ${response.status}`);
	expect(response.headers.get("WWW-Authenticate") !== null, "no WWW-Authenticate");
});

const client = new Client({ name: "loopback-smoke", version: "1.0.0" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: auth } }),
);

await check("MCP lists the seven tools", async () => {
	const { tools } = await client.listTools();
	expect(tools.length === 7, `${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
});

await check("a blocking ask_question wakes within 5 s of the reply", async () => {
	const question = `Smoke test ${new Date().toISOString()}?`;
	const call = client.callTool(
		{ name: "ask_question", arguments: { question, project } },
		{ timeout: 60_000, resetTimeoutOnProgress: true, onprogress: () => {} },
	);
	const askId = await openAsk(question);
	const replied = Date.now();
	await reply(askId, { outcome: "answered", selected: [], text: "Smoke." });
	const result = await call;
	const woke = Date.now() - replied;
	expect(result.isError !== true, `the tool failed: ${JSON.stringify(result.content)}`);
	const body = result.structuredContent as { askId?: string; reply?: { text?: string } };
	expect(body.askId === askId && body.reply?.text === "Smoke.", JSON.stringify(body));
	expect(woke < 5_000, `woke ${woke} ms after the reply`);
	return `${askId}, woke ${woke} ms after the reply`;
});

await check("an image uploads with create_image_upload and reads back the same", async () => {
	const issued = await client.callTool({
		name: "create_image_upload",
		arguments: { contentType: "image/png" },
	});
	const ticket = issued.structuredContent as { uploadId: string; uploadUrl: string };
	const stored = await fetch(ticket.uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": "image/png" },
		body: png,
	});
	expect(stored.status === 201, `PUT answered ${stored.status}: ${await stored.text()}`);
	const file = await fetch(`${api}/files/${ticket.uploadId}`, { headers: auth });
	expect(file.status === 200, `GET answered ${file.status}`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	expect(
		bytes.length === png.length && bytes.every((byte, index) => byte === png[index]),
		`read back ${bytes.length} bytes, not the same ${png.length}`,
	);
	return ticket.uploadId;
});

await check("the event socket sends the space, then a new ask", async () => {
	const issued = await json(
		await fetch(`${api}/events/tickets`, { method: "POST", headers: auth }),
	);
	const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/v1/events`, [
		"loopback.v1",
		`loopback.ticket.${String(issued["ticket"])}`,
	]);
	const frames: { type: string; ask?: { id: string } }[] = [];
	const question = `Socket smoke test ${new Date().toISOString()}?`;
	const done = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`frames: ${JSON.stringify(frames)}`)), 15_000);
		socket.addEventListener("error", () => reject(new Error("the socket failed to open")));
		socket.addEventListener("message", (event) => {
			const frame = JSON.parse(String(event.data)) as { type: string; ask?: { id: string } };
			frames.push(frame);
			if (frames.length === 1) {
				expect(frame.type === "snapshot", `first frame ${frame.type}`);
				void client
					.callTool(
						{ name: "ask_question", arguments: { question, project } },
						{ timeout: 60_000, resetTimeoutOnProgress: true, onprogress: () => {} },
					)
					.catch(() => {});
			} else if (frame.type === "ask.opened") {
				clearTimeout(timer);
				resolve(frame.ask?.id ?? "");
			}
		});
	});
	const askId = await done;
	socket.close();
	await reply(askId, { outcome: "dismissed" });
	return askId;
});

if (existing !== undefined) {
	await check(`the existing ask ${existing} reads back, with its image`, async () => {
		const response = await fetch(`${api}/asks/${encodeURIComponent(existing)}`, { headers: auth });
		expect(response.status === 200, `status ${response.status}`);
		const ask = await json(response);
		const image = JSON.stringify(ask).match(/"uploadId":"([^"]+)"/)?.[1];
		if (image === undefined) return `${String(ask["kind"])}, no image in it`;
		const file = await fetch(`${api}/files/${image}`, { headers: auth });
		expect(file.status === 200, `its image ${image} answered ${file.status}`);
		return `${String(ask["kind"])}, image ${image} (${(await file.arrayBuffer()).byteLength} bytes)`;
	});
}

await client.close();
console.log("Every check passed.");
