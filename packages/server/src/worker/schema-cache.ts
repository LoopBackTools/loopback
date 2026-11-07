/** A schema the MCP SDK can turn into JSON Schema, as zod 4.2 and later are. */
interface JsonSchemaSource {
	readonly "~standard": {
		readonly jsonSchema: {
			readonly input: (options: { readonly target: string }) => unknown;
			readonly output: (options: { readonly target: string }) => unknown;
		};
	};
}

/** Freezes a converted JSON Schema all the way down: every request's server shares it. */
const frozen = <T>(value: T): T => {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const inner of Object.values(value)) frozen(inner);
		Object.freeze(value);
	}
	return value;
};

/**
 * The schema, with its JSON Schema worked out once per isolate rather than on every request. The SDK
 * converts a tool's schemas for each `McpServer` it builds, and Loopback builds one per request, so
 * `tools/list` and every 2026-07-28 `tools/call` would convert all of them again. The result is the
 * same every time: a schema never changes, and the result is frozen, so nothing a request does to it
 * reaches the next. Everything else, validation included, is the schema's own.
 */
export const withCachedJsonSchema = <S extends JsonSchemaSource>(schema: S): S => {
	const standard = schema["~standard"];
	const converted = new Map<string, unknown>();
	const cached =
		(io: "input" | "output") =>
		(options: { readonly target: string }): unknown => {
			const key = `${io} ${options.target}`;
			if (!converted.has(key)) converted.set(key, frozen(standard.jsonSchema[io](options)));
			return converted.get(key);
		};
	const wrapped: S = Object.create(schema);
	Object.defineProperty(wrapped, "~standard", {
		value: { ...standard, jsonSchema: { input: cached("input"), output: cached("output") } },
	});
	return wrapped;
};
