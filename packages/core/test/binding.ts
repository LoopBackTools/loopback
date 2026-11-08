import { env } from "cloudflare:workers";
import type { Core } from "../src/core.ts";

/**
 * The core as an edge reaches it: `CORE`, a service binding to this Worker's own `Core` entrypoint,
 * so every call crosses a real binding. A binding that names its Worker by string is typed as a
 * plain `Fetcher`, so it is named here as the entrypoint it binds.
 */
export const core = () => env.CORE as Service<Core>;

/**
 * The core as a Workers for Platforms dispatch reaches it: `CORE_DEFAULT`, a service binding to
 * this Worker's default export. Dispatch can't name an entrypoint, so this is the only way in.
 */
export const coreByDefault = () => env.CORE_DEFAULT as Service<Core>;
