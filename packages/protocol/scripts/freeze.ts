/**
 * Freezes each revision of the contract the spec emits that isn't frozen yet: copies
 * `openapi/openapi.<n>.json` to `revisions/<n>.json`. Run it once, after declaring a new revision
 * and running `pnpm generate`. It never overwrites a revision already frozen: a shipped revision is
 * history, and `test/revisions.test.ts` fails if the spec stops emitting it unchanged.
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const emitted = readdirSync(join(root, "openapi")).flatMap((name) => {
	const match = /^openapi\.(\d+)\.json$/.exec(name);
	return match === null ? [] : [match[1]];
});

for (const revision of emitted) {
	const frozen = join(root, "revisions", `${revision}.json`);
	if (existsSync(frozen)) continue;
	copyFileSync(join(root, "openapi", `openapi.${revision}.json`), frozen);
	console.log(`Froze revision ${revision}.`);
}
