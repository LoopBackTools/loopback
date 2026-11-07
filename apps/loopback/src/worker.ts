import { createLoopback, ConfiguredGate } from "@loopbacktools/server";
import { env } from "cloudflare:workers";

export { Space } from "@loopbacktools/server";

export default createLoopback({
	gate: ConfiguredGate,
	plan: env.LOOPBACK_PLAN === "paid" ? "paid" : "free",
});
