import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";

/**
 * Every dependency in the workspace points inward, towards the contract:
 *
 *     protocol  ←  core  ←  apps/loopback-core
 *        ↑   ↖______________  apps/loopback's edge (the core's RPC module only)
 *       sdk  ←  inbox  ←  app  ←  apps/loopback's web inbox
 *
 * The core is shared verbatim by every deployment and each repo owns its edge, so an edge reaches the
 * core only through `@loopbacktools/core/rpc`, and nothing shared reaches an edge. These rules read
 * each package's source; tests may import what they test. The core's own rules, inside it, are in
 * packages/core/test/arch.
 */

const root = resolve(import.meta.dirname, "..");

/** Each part of the workspace, by the folder its source is in, and the workspace modules it may import. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
	"packages/protocol/src": [],
	"packages/core/src": ["@loopbacktools/protocol"],
	"packages/sdk/src": ["@loopbacktools/protocol"],
	"packages/inbox/src": ["@loopbacktools/sdk", "@loopbacktools/protocol"],
	"packages/app/src": ["@loopbacktools/inbox", "@loopbacktools/sdk", "@loopbacktools/protocol"],
	"apps/loopback/src/edge": ["@loopbacktools/core/rpc", "@loopbacktools/protocol"],
	"apps/loopback/src/web": [
		"@loopbacktools/app",
		"@loopbacktools/inbox",
		"@loopbacktools/sdk",
		"@loopbacktools/protocol",
	],
	"apps/loopback/src/generated": ["@loopbacktools/protocol"],
	"apps/loopback-core/src": ["@loopbacktools/core"],
};

/** Where each part's relative imports may lead: inside its own package. */
const packageOf = (folder: string) => folder.split("/").slice(0, 2).join("/");

/**
 * Whether `specifier` is one of `allowed`: the module itself, or one of its subpaths, except that a
 * module ending in a subpath allows only that subpath. `@loopbacktools/protocol` allows
 * `@loopbacktools/protocol/schema`; `@loopbacktools/core/rpc` does not allow `@loopbacktools/core`.
 */
const allows = (allowed: readonly string[], specifier: string) =>
	allowed.some((module) => specifier === module || specifier.startsWith(`${module}/`));

const SOURCE = /\.(ts|tsx)$/;

/** Every source file under a folder, relative to the workspace. */
const filesIn = async (folder: string): Promise<string[]> =>
	(await readdir(join(root, folder), { recursive: true }))
		.filter((name) => SOURCE.test(name) && !name.endsWith(".d.ts"))
		.map((name) => join(folder, name));

/**
 * The modules a file names, read by a JavaScript lexer from the file with TypeScript's own syntax
 * erased, type-only imports kept as imports: a type is a dependency too. JSX is erased with it, so
 * the lexer reads only the imports at the top of a `.tsx` file.
 */
const importsOf = async (file: string): Promise<string[]> => {
	await init();
	const source = await readFile(join(root, file), "utf8");
	const typesAsValues = source
		.replace(/\bimport\s+type\s+(?=[{*]|[\w$]+\s+from\b)/g, "import ")
		.replace(/\bexport\s+type\s+(?=[{*])/g, "export ");
	const imports = file.endsWith(".tsx")
		? (
				typesAsValues.match(
					/^(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^import\s+["'][^"']+["'];?/gm,
				) ?? []
			).join("\n")
		: typesAsValues;
	return parse(stripTypeScriptTypes(imports, { mode: "strip" }))[0].flatMap((entry) =>
		typeof entry.specifier === "string" ? [entry.specifier] : [],
	);
};

/** Every import in a part that its rule refuses, as `"<file> imports <module>"`. */
const offenders = async (folder: string, allowed: readonly string[]) => {
	const found: string[] = [];
	for (const file of await filesIn(folder)) {
		for (const specifier of await importsOf(file)) {
			if (specifier.startsWith(".")) {
				const target = relative(root, resolve(root, dirname(file), specifier));
				if (!target.startsWith(`${packageOf(folder)}/`)) {
					found.push(`${file} imports ${specifier}, outside ${packageOf(folder)}`);
				}
			} else if (specifier.startsWith("@loopbacktools/") && !allows(allowed, specifier)) {
				found.push(`${file} imports ${specifier}`);
			}
		}
	}
	return found;
};

/** The import cycles among a folder's files, each as the files it passes through. */
const cyclesIn = async (folder: string): Promise<string[][]> => {
	const files = await filesIn(folder);
	const known = new Set(files);
	const edges = new Map<string, string[]>();
	for (const file of files) {
		edges.set(
			file,
			(await importsOf(file))
				.filter((specifier) => specifier.startsWith("."))
				.map((specifier) => relative(root, resolve(root, dirname(file), specifier)))
				.filter((target) => known.has(target)),
		);
	}
	const cycles: string[][] = [];
	const done = new Set<string>();
	const visit = (file: string, path: readonly string[]) => {
		const seen = path.indexOf(file);
		if (seen !== -1) {
			cycles.push([...path.slice(seen), file]);
			return;
		}
		if (done.has(file)) return;
		for (const next of edges.get(file) ?? []) visit(next, [...path, file]);
		done.add(file);
	};
	for (const file of files) visit(file, []);
	return cycles;
};

describe("the workspace's dependencies", () => {
	// A rule over a folder that does not exist passes by matching nothing: a renamed folder would
	// disarm it without a word. So each must exist, and hold code.
	it.each(Object.keys(ALLOWED))("include %s, with code in it", async (folder) => {
		expect((await filesIn(folder)).length).toBeGreaterThan(0);
	});

	it.each(Object.entries(ALLOWED))(
		"let %s import only the workspace modules inward of it",
		async (folder, allowed) => {
			expect(await offenders(folder, allowed)).toEqual([]);
		},
	);

	it.each(["apps/loopback/src/edge", "packages/sdk/src", "packages/inbox/src", "packages/app/src"])(
		"have no import cycles in %s",
		async (folder) => {
			expect(await cyclesIn(folder)).toEqual([]);
		},
	);
});
