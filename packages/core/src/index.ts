/**
 * A whole core Worker: `export { default, Core, Space } from "@loopbacktools/core"`, with `Space`
 * declared as a SQLite Durable Object, `FILES` bound to R2 and `CF_VERSION_METADATA` declared.
 * It has no public routes.
 *
 * `Core` is also the default export: a Workers for Platforms dispatch can't name an entrypoint, so a
 * core uploaded per workspace is reached only through its default export. A service binding may name
 * either.
 */
export { Core, Core as default } from "./core.ts";
export type { CoreBindings } from "./env.ts";
export { Space } from "./space/object.ts";
