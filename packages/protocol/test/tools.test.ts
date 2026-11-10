import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	Client,
	fromJsonSchema,
	type JsonSchemaType,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer, type Tool } from "@modelcontextprotocol/server";
import { compile, type Diagnostic, NodeHost } from "@typespec/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Agents' tools are generated from the contract's `Agent` operations by `typespec-http-mcp`, which
 * every edge compiles. Agents must find the tools they have always had: the same names, titles,
 * descriptions and arguments, word for word, as the server listed before the contract declared them.
 * `tools.r1.json` is that listing, taken through an MCP client from the 0.7.1 server.
 */

const root = join(import.meta.dirname, "..");

/**
 * The options an edge compiles the contract's tools with. The document is OpenAPI 3.1, as the
 * protocol publishes it, which is what lets a property admit `null`.
 */
const OPTIONS = {
	"typespec-http-mcp": { "seal-object-schemas": true, "tool-tags": ["Agent"] },
	"@typespec/openapi3": { "openapi-versions": ["3.1.0"] },
};

/** MCP's reading of each hint a tool leaves out: the specification's `ToolAnnotations` defaults. */
const DEFAULT_HINTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/**
 * Hints the emitter cannot state yet. It derives hints from the HTTP method alone, and no method
 * says a call destroys nothing or stays inside this service, so clients read the defaults where the
 * server said `false` (typespec-emitters FEEDBACK-from-loopback.md §7). Remove each one when the
 * emitter can state it: this test then fails until it does.
 */
const UNSTATED_HINTS = ["destructiveHint", "openWorldHint"] as const;

/**
 * Hints the 0.7 server left unsaid that the emitter now states from the method, each true of the
 * tool: a read is idempotent.
 */
const NEWLY_STATED_HINTS: Readonly<Record<string, Tool["annotations"]>> = {
	open_inbox: { idempotentHint: true },
};

/** What a tool's hints mean, with every hint it left out read as MCP reads it. */
const hintsOf = (annotations: Tool["annotations"]) => ({ ...DEFAULT_HINTS, ...annotations });

/**
 * The arguments' schema as the emitter publishes it. It merges the body into the arguments without
 * the input model's own description; every argument keeps its own (FEEDBACK-from-loopback.md §6).
 * Remove this when the emitter keeps it: this test then fails until it does.
 */
const argumentsOf = (schema: Tool["inputSchema"]) => {
	const { description: _, ...rest } = schema;
	return rest;
};

interface Recorded {
	readonly tools: readonly Tool[];
}

const recorded = (JSON.parse(readFileSync(join(root, "test/tools.r1.json"), "utf8")) as Recorded)
	.tools;

/** Generated inside the package, so the generated module resolves the package's dependencies. */
let output: string;
let diagnostics: readonly Diagnostic[];
let listed: readonly Tool[];

/** The tools a server lists once the generated `registerTools` has registered them. */
const listTools = async (registerTools: (...args: never[]) => unknown): Promise<Tool[]> => {
	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: "loopback", version: "0.0.0" });
		(registerTools as (server: McpServer, handlersFor: () => object, deps: object) => unknown)(
			server,
			() => ({}),
			{
				permits: () => true,
				context: () => ({}),
				noContext: () => ({ content: [], isError: true }),
			},
		);
		return server;
	});
	const client = new Client({ name: "tools-test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://tools.test/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
};

beforeAll(async () => {
	output = mkdtempSync(join(root, "test", ".tools-"));
	const program = await compile(NodeHost, join(root, "spec/main.tsp"), {
		outputDir: output,
		emit: ["typespec-http-mcp"],
		options: {
			...OPTIONS,
			"typespec-http-mcp": { ...OPTIONS["typespec-http-mcp"], "emitter-output-dir": output },
		},
	});
	diagnostics = program.diagnostics;
	// A contract that selects no tool gets no tools file at all.
	const file = join(output, "mcp.gen.ts");
	if (!existsSync(file)) {
		listed = [];
		return;
	}
	const generated = (await import(file)) as {
		readonly registerTools: (...args: never[]) => unknown;
	};
	listed = await listTools(generated.registerTools);
}, 120_000);

afterAll(() => {
	rmSync(output, { recursive: true, force: true });
});

const generatedTool = (name: string): Tool => {
	const tool = listed.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`The contract generates no tool "${name}".`);
	return tool;
};

describe("the agent's tools, generated from the contract", () => {
	it("compile without a word from the compiler or the emitter", () => {
		expect(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)).toEqual(
			[],
		);
	});

	it("are the seven tools agents already know", () => {
		expect(listed.map((tool) => tool.name).toSorted()).toEqual(
			recorded.map((tool) => tool.name).toSorted(),
		);
	});

	it.each(recorded.map((tool) => [tool.name, tool] as const))(
		"say %s word for word",
		(name, today) => {
			const tool = generatedTool(name);
			expect(tool.title).toBe(today.title);
			expect(tool.description).toBe(today.description);
			expect(tool.inputSchema).toEqual(argumentsOf(today.inputSchema));
		},
	);

	it.each(recorded.map((tool) => [tool.name, tool] as const))(
		"hint at what %s does as it always has",
		(name, today) => {
			const unstated = Object.fromEntries(
				UNSTATED_HINTS.map((hint) => [hint, DEFAULT_HINTS[hint]]),
			);
			expect(hintsOf(generatedTool(name).annotations)).toEqual({
				...hintsOf(today.annotations),
				...unstated,
				...NEWLY_STATED_HINTS[name],
			});
		},
	);

	const answered = recorded.filter((tool) => tool.outputSchema !== undefined);
	const waits = recorded.filter((tool) => tool.outputSchema === undefined);

	it("wait in five of them, and answer at once in the rest", () => {
		expect(waits.map((tool) => tool.name).toSorted()).toEqual([
			"answer_briefing",
			"answer_follow_up",
			"ask_question",
			"request_review",
			"send_briefing",
		]);
		expect(answered.map((tool) => tool.name).toSorted()).toEqual([
			"create_image_upload",
			"open_inbox",
		]);
	});

	it.each(answered.map((tool) => [tool.name, tool] as const))(
		"answer %s with the result it always had",
		(name, today) => {
			expect(generatedTool(name).outputSchema).toEqual(today.outputSchema);
		},
	);

	it.each(waits.map((tool) => [tool.name] as const))(
		"answer %s with the reply and what it means, or how to keep waiting",
		async (name) => {
			// As the client checks a result: against the schema the tool publishes.
			const tool = generatedTool(name);
			expect(tool.outputSchema).toBeDefined();
			const schema = fromJsonSchema(tool.outputSchema as JsonSchemaType);
			const accepts = async (body: unknown) =>
				!("issues" in (await schema["~standard"].validate(body)));
			expect(
				await accepts({
					askId: "ask-1",
					reply: { outcome: "answered", selected: ["D1"] },
					message: 'The person answered. They chose: "D1".',
				}),
			).toBe(true);
			expect(
				await accepts({
					askId: "ask-1",
					reply: null,
					message: `No reply yet. Call ${name} again.`,
				}),
			).toBe(true);
			expect(await accepts({ askId: "ask-1", message: "No reply yet." })).toBe(false);
		},
	);
});
