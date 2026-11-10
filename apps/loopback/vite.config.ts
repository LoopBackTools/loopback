import { resolve } from "node:path";
import { loadAndParseConfig } from "@cloudflare/config";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The core, from its own `cloudflare.config.ts`, parsed as the plugin parses this app's: run beside
 * the edge in `pnpm dev`, so the edge's `CORE` binding reaches it. Never built with the edge: the
 * core is deployed on its own, first.
 */
const coreFor = async (mode: string) => {
	const path = resolve(import.meta.dirname, "../loopback-core/cloudflare.config.ts");
	const { result } = await loadAndParseConfig(path, { isPreview: false, mode });
	if (!result.success || result.data.worker === undefined) {
		throw new Error(
			`apps/loopback-core/cloudflare.config.ts doesn't parse: ${String(result.error)}`,
		);
	}
	return result.data.worker;
};

export default defineConfig(async ({ mode }) => ({
	plugins: [
		react(),
		tailwindcss(),
		cloudflare({ auxiliaryWorkers: [{ config: await coreFor(mode), devOnly: true }] }),
	],
}));
