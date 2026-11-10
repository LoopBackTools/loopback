import type { Problem } from "@loopbacktools/protocol";

export const problem = (code: string, message: string): Problem => ({ code, message });

/** A deployment that can't serve any request until it is configured. Answered as a 500 that says why. */
export class NotConfigured extends Error {
	override readonly name = "NotConfigured";
}
