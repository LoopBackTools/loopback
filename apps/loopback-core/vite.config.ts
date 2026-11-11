import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

/**
 * `cf build` and `cf deploy` build the core through Vite, and the plugin reads the Worker from
 * `cloudflare.config.ts`. The core has no assets, so this builds the Worker alone.
 */
export default defineConfig({ plugins: [cloudflare()] });
