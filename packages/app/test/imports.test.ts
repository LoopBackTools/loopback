import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { init, parse } from "es-module-lexer";
import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";

/**
 * The app and the inbox are the same for every deployment, so they import nothing of any one: no
 * sign-in library, nothing about accounts. What they may import is listed here; a deployment brings
 * the rest through the app's ports. See docs/design/one-app.md.
 */
const ALLOWED = new Set([
	"react",
	"react/jsx-runtime",
	"react-router",
	"react-markdown",
	"remark-gfm",
	"effect",
	"effect/reactivity",
	"@effect/atom-react",
	"@cloudflare/kumo",
	"@cloudflare/kumo/code",
	"@phosphor-icons/react",
	"@loopbacktools/sdk",
	"@loopbacktools/inbox",
]);

const root = join(import.meta.dirname, "../../..");
const PACKAGES = ["packages/app/src", "packages/inbox/src"];

/**
 * Every module a file imports, types included: its import and export statements, read from the
 * JavaScript it compiles to, and the type-only imports that compiling erases.
 */
const importsOf = async (file: string): Promise<string[]> => {
	const source = await readFile(file, "utf8");
	const { code } = await transformWithOxc(source, file);
	await init();
	const [imports] = parse(code);
	const types = [...source.matchAll(/^import type [^;]+? from "([^"]+)";/gms)].map(
		(match) => match[1] ?? "",
	);
	return [
		...imports.flatMap(({ specifier }) => (typeof specifier === "string" ? [specifier] : [])),
		...types,
	];
};

/** `"packages/inbox/src/detail.tsx imports better-auth"` for each import that isn't allowed. */
const offenders = async (folder: string) => {
	const found: string[] = [];
	for (const name of await readdir(join(root, folder), { recursive: true })) {
		if (!/\.tsx?$/.test(name)) continue;
		const file = join(root, folder, name);
		for (const specifier of await importsOf(file)) {
			if (!specifier.startsWith(".") && !ALLOWED.has(specifier)) {
				found.push(`${relative(root, file)} imports ${specifier}`);
			}
		}
	}
	return found;
};

describe("the app and the inbox", () => {
	it("are read for their imports, every one", async () => {
		expect(await importsOf(join(root, "packages/app/src/app.tsx"))).toEqual(
			expect.arrayContaining(["react-router", "@loopbacktools/inbox", "./ports.ts"]),
		);
	});

	it.each(PACKAGES)("import only what every deployment shares, in %s", async (folder) => {
		expect(await offenders(folder)).toEqual([]);
	});
});
