import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { projectFiles } from "archunit";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";

/**
 * The core is the one build every deployment shares, so what it may import is held here. It knows
 * the contract and Effect, and nothing of any edge: no HTTP framework, MCP, gate, or code generated
 * from the contract. Inside it, the domain knows nothing else, and the space (the Durable Object and
 * its operations) knows only the domain. `rpc.ts` is what edges import, so it brings nothing with it.
 */
const FOLDERS = ["src", "src/domain", "src/space"] as const;

/** What the core may import from outside itself. */
const PACKAGES =
	/^(effect(\/|$)|@effect\/sql-sqlite-do$|@loopbacktools\/protocol(\/|$)|cloudflare:workers$)/;

/** The only files that reach the Workers runtime: the Durable Object, and the entrypoint. */
const RUNTIME = new Set(["src/space/object.ts", "src/core.ts"]);

/** Every TypeScript file under a folder, as a path relative to the package. */
const filesIn = async (folder: string): Promise<string[]> =>
	(await readdir(folder, { recursive: true }))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(folder, name));

/**
 * The modules a file names, read by a JavaScript lexer from the file with TypeScript's own syntax
 * erased, which the lexer can read reliably: `every` with type-only imports kept as imports, and
 * `runtime` as the runtime loads it, with them gone.
 */
const importsOf = async (file: string) => {
	await init();
	const source = await readFile(file, "utf8");
	const specifiers = (javascript: string) =>
		parse(javascript)[0].flatMap((entry) =>
			typeof entry.specifier === "string" ? [entry.specifier] : [],
		);
	const typesAsValues = source
		.replace(/\bimport\s+type\s+(?=[{*]|[\w$]+\s+from\b)/g, "import ")
		.replace(/\bexport\s+type\s+(?=[{*])/g, "export ");
	return {
		every: specifiers(stripTypeScriptTypes(typesAsValues, { mode: "strip" })),
		runtime: specifiers(stripTypeScriptTypes(source, { mode: "strip" })),
	};
};

/** `"src/domain/ask.ts imports hono"` for every module a file in `folder` names that `allowed` refuses. */
const offenders = async (
	folder: string,
	allowed: (specifier: string, file: string) => boolean,
	which: "every" | "runtime" = "every",
) => {
	const found: string[] = [];
	for (const file of await filesIn(folder)) {
		for (const specifier of (await importsOf(file))[which]) {
			if (!allowed(specifier, file)) found.push(`${relative(".", file)} imports ${specifier}`);
		}
	}
	return found;
};

const isRelative = (specifier: string) => specifier.startsWith(".");

describe("the core's dependencies", () => {
	// A rule over a folder that does not exist passes by matching nothing: a renamed folder would
	// disarm every rule below without a word. So each must exist, and hold code.
	it.each(FOLDERS)("include %s, with code in it", async (folder) => {
		expect((await filesIn(folder)).length).toBeGreaterThan(0);
	});

	it("import only the contract, Effect, SQLite on Durable Objects and the Workers runtime", async () => {
		expect(
			await offenders("src", (specifier) => isRelative(specifier) || PACKAGES.test(specifier)),
		).toEqual([]);
	});

	it("reach the Workers runtime only from the Durable Object and the entrypoint", async () => {
		expect(
			await offenders(
				"src",
				(specifier, file) => !specifier.startsWith("cloudflare:") || RUNTIME.has(file),
			),
		).toEqual([]);
	});

	it("let the domain import only Effect and the contract", async () => {
		expect(
			await offenders(
				"src/domain",
				(specifier) =>
					isRelative(specifier) ||
					specifier === "effect" ||
					specifier.startsWith("@loopbacktools/protocol"),
			),
		).toEqual([]);
	});

	it("keep the domain to itself", async () => {
		const violations = await projectFiles()
			.inFolder("src/domain/**")
			.shouldNot()
			.dependOnFiles()
			.inFolder("src/space/**")
			.check();
		expect(violations).toEqual([]);
		expect(
			await offenders(
				"src/domain",
				(specifier) => !isRelative(specifier) || specifier.startsWith("./"),
			),
		).toEqual([]);
	});

	it("keep the space to itself and the domain", async () => {
		expect(
			await offenders(
				"src/space",
				(specifier) =>
					!isRelative(specifier) ||
					specifier.startsWith("./") ||
					specifier.startsWith("../domain/"),
			),
		).toEqual([]);
	});

	it("give edges an RPC module that brings nothing of the core with it", async () => {
		expect(await offenders("src", (_specifier, file) => file !== "src/rpc.ts", "runtime")).toEqual(
			[],
		);
	});

	it("have no import cycles", async () => {
		expect(await projectFiles().inFolder("src/**").should().haveNoCycles().check()).toEqual([]);
	});
});
