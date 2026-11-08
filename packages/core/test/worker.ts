export { Core } from "../src/core.ts";
export { Space } from "../src/space/object.ts";

export default {
	fetch: () => new Response("Loopback's core has no public routes.", { status: 404 }),
} satisfies ExportedHandler;
