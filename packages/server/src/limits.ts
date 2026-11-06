import type { Problem } from "@loopbacktools/protocol";

/** The problem code a request refused by a rate limit is answered with. */
export const RATE_LIMITED = "request.rate_limited";

/**
 * A refused request's 429, saying in `Retry-After` how many seconds to wait. An MCP client is
 * answered with a JSON-RPC error, which it shows its agent; anything else, with the API's problem.
 * For a host's own limits in front of Loopback, too, so a caller is refused the same way by each.
 */
export const tooManyRequests = (
	request: Request,
	retryAfter: number,
	message: string,
): Response => {
	const headers = { "Retry-After": String(retryAfter) };
	if (new URL(request.url).pathname === "/mcp") {
		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32000, message } },
			{ status: 429, headers },
		);
	}
	const problem: Problem = { code: RATE_LIMITED, message };
	return Response.json(problem, { status: 429, headers });
};
