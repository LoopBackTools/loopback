/**
 * A whole core Worker: `export { default, Core, Space } from "@loopbacktools/core"`, with `Space`
 * declared as a SQLite Durable Object, `FILES` bound to R2 and `CF_VERSION_METADATA` declared.
 * Edges reach it through a service binding to its `Core` entrypoint; it has no public routes.
 */
export { Core } from "./core.ts";
export type { CoreBindings } from "./env.ts";
export { Space } from "./space/object.ts";

export default {
	fetch: () => new Response("Loopback's core has no public routes.", { status: 404 }),
} satisfies ExportedHandler;
