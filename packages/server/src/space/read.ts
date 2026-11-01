import { Result, Schema } from "effect";

/**
 * Reading what a space is handed or holds: decoded with the schemas generated from the contract,
 * never cast. A message holding something from a newer revision of the contract, a member of a union
 * those schemas decode as `unknown`, can't be read either: this code would only guess at it. See
 * docs/design/versioned-messages.md.
 */
export const read = <A>(
	schema: Schema.Codec<A, unknown>,
	value: unknown,
): Result.Result<A, string> => {
	const decoded = Schema.decodeUnknownResult(schema)(value);
	if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message);
	const found = unreadable(decoded.success);
	return found === undefined
		? Result.succeed(decoded.success)
		: Result.fail(`it holds ${found}, from a newer revision of the contract`);
};

/** What a decoded message holds that this code can't read, if anything. */
const unreadable = (value: unknown): string | undefined => {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	for (const tag of ["kind", "type", "outcome"]) {
		if (record[tag] === "unknown" && typeof record["was"] === "string") {
			return `the ${tag} "${record["was"]}"`;
		}
	}
	for (const inner of Object.values(record)) {
		const found = unreadable(inner);
		if (found !== undefined) return found;
	}
	return undefined;
};
