import type { Caller, CoreRpc } from "@loopbacktools/core/rpc";
import { problem } from "./problems.ts";

/** The prefix a browser puts its event ticket behind in `Sec-WebSocket-Protocol`. */
const TICKET_PROTOCOL_PREFIX = "loopback.ticket.";

/** A one-time pass onto a space's events: the space it names, by object id, and its secret. */
interface Ticket {
	readonly spaceId: string;
	readonly secret: string;
}

/** A ticket as the core issues it, `<spaceId>.<secret>`, split; none when it isn't one. */
const split = (ticket: string): Ticket | undefined => {
	const dot = ticket.indexOf(".");
	if (dot <= 0 || dot === ticket.length - 1) return undefined;
	return { spaceId: ticket.slice(0, dot), secret: ticket.slice(dot + 1) };
};

/** The event ticket a socket upgrade offers, if it offers one. */
export const offeredTicket = (request: Request): string | undefined =>
	(request.headers.get("Sec-WebSocket-Protocol") ?? "")
		.split(",")
		.map((protocol) => protocol.trim())
		.find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX))
		?.slice(TICKET_PROTOCOL_PREFIX.length);

/** An upgrade refused for want of a ticket the core will take. */
export const ticketRefused = (message: string) =>
	Response.json(problem("auth.unauthorized", message), {
		status: 401,
		headers: { "WWW-Authenticate": 'Bearer realm="loopback"' },
	});

/**
 * Hands an inbox's socket upgrade to the core, which spends the ticket and answers with the space's
 * own socket, sending the space as it stands first. The core takes nothing else from outside.
 */
export const forwardWithTicket = (core: CoreRpc, request: Request, ticket: string) => {
	const parts = split(ticket);
	if (parts === undefined) return Promise.resolve(ticketRefused("The event ticket is not valid."));
	const url = new URL(`https://core/spaces/id/${encodeURIComponent(parts.spaceId)}/events`);
	url.searchParams.set("ticket", parts.secret);
	return core.fetch(new Request(url, request));
};

/**
 * Opens the event socket for a client the gate already let in by its header: the edge issues it a
 * ticket for its own space, and spends it at once.
 */
export const forwardFor = async (core: CoreRpc, request: Request, caller: Caller) => {
	const issued = await core.EventTickets_issue(caller, {});
	return forwardWithTicket(core, request, issued.body.ticket);
};
