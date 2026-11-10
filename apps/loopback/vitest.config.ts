import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			// The inbox's component tests run in jsdom, without the Worker build the app's Vite config adds.
			{
				plugins: [react()],
				test: {
					name: "web",
					environment: "jsdom",
					include: ["test/**/*.test.{ts,tsx}"],
					exclude: ["test/edge/**"],
					setupFiles: ["./test/setup.ts"],
				},
			},
			// The edge's tests run in the Workers runtime, against the edge and the core in one Worker.
			{
				plugins: [
					cloudflareTest({
						experimental: { newConfig: { configPath: "./test/edge/cloudflare.config.ts" } },
					}),
				],
				test: {
					name: "edge",
					include: ["test/edge/**/*.test.ts"],
					setupFiles: ["./test/edge/setup.ts"],
					// A slot for every file, so no file starts in a runtime another has used (see the
					// core's vitest config).
					maxWorkers: 12,
					// Its own group, since it takes its own number of workers and the web project does not.
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
