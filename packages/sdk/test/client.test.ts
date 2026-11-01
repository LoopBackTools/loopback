import { BUILD_HEADER, RELOAD_CODE, REVISION_HEADER } from "@loopbacktools/protocol";
import { type Ask, REVISION, type ServerEvent } from "@loopbacktools/protocol/schema";
import { describe, expect, it } from "vitest";
import { ApiError, createLoopbackClient, type InboxState, type Update } from "../src/index.ts";

const ask: Ask = {
	kind: "question",
	prompt: { question: "Tabs or spaces?", options: [{ label: "Tabs" }], multiple: false },
	id: "ask-1",
	status: "awaiting_human",
	waiting: true,
	thread: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A WebSocket the test drives by hand. */
class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static readonly opened: FakeSocket[] = [];
	readonly url: string;
	readonly protocols: string[];
	readyState = FakeSocket.OPEN;
	readonly sent: string[] = [];
	closed = false;

	constructor(url: string, protocols: string[]) {
		super();
		this.url = url;
		this.protocols = protocols;
		FakeSocket.opened.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
	}

	receive(frame: ServerEvent | Record<string, unknown>) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	drop() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}

const recording = (responses: Record<string, () => Response>) => {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, init });
		const path = new URL(url).pathname;
		const respond = responses[`${init?.method ?? "GET"} ${path}`];
		return respond === undefined ? new Response("{}", { status: 404 }) : respond();
	};
	return { calls, fetch: fetch as typeof globalThis.fetch };
};

const until = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition never held");
};

describe("the client", () => {
	it("sends the token and the reply", async () => {
		const { calls, fetch } = recording({
			[`POST /api/v1/asks/ask-1/reply`]: () => Response.json({ ...ask, status: "closed" }),
		});
		const client = createLoopbackClient({ baseUrl: "https://lb.test/", token: "secret", fetch });
		const closed = await client.reply("ask-1", { outcome: "answered", selected: ["Tabs"] });
		expect(closed.status).toBe("closed");
		expect(calls[0]?.url).toBe("https://lb.test/api/v1/asks/ask-1/reply");
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer secret");
		expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
			outcome: "answered",
			selected: ["Tabs"],
		});
	});

	it("rejects with the server's problem as an ApiError", async () => {
		const { fetch } = recording({
			[`POST /api/v1/asks/ask-1/reply`]: () =>
				Response.json({ code: "ask.closed", message: "Already answered." }, { status: 409 }),
		});
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			token: async () => "fresh",
			fetch,
		});
		const error = await client
			.reply("ask-1", { outcome: "dismissed" })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, code: "ask.closed", message: "Already answered." });
	});

	it("follows the inbox live, and reconnects when the socket drops", async () => {
		FakeSocket.opened.length = 0;
		let issued = 0;
		const { calls, fetch } = recording({
			[`POST /api/v1/events/tickets`]: () => {
				issued += 1;
				return Response.json(
					{ ticket: `space.pass${issued}`, expiresAt: "2026-01-01T00:01:00.000Z" },
					{ status: 201 },
				);
			},
		});
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			token: "secret",
			fetch,
			WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
		});
		const states: InboxState[] = [];
		const stop = client.inbox.subscribe(() => states.push(client.inbox.getSnapshot()));
		await until(() => FakeSocket.opened.length === 1);
		const first = FakeSocket.opened[0];
		expect(first?.url).toBe("wss://lb.test/api/v1/events");
		// The socket opens with a one-time ticket; the token goes only in a header.
		expect(first?.protocols).toEqual(["loopback.v1", "loopback.ticket.space.pass1"]);
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer secret");

		first?.receive({ type: "snapshot", snapshot: { open: [], recent: [] } });
		first?.receive({ type: "ask.opened", ask });
		await until(() => client.inbox.getSnapshot().open.length === 1);
		expect(client.inbox.getSnapshot().status).toBe("live");

		first?.drop();
		await until(() => client.inbox.getSnapshot().status === "reconnecting");
		await until(() => FakeSocket.opened.length === 2);
		expect(FakeSocket.opened[1]?.protocols).toEqual(["loopback.v1", "loopback.ticket.space.pass2"]);
		FakeSocket.opened[1]?.receive({ type: "snapshot", snapshot: { open: [], recent: [ask] } });
		await until(() => client.inbox.getSnapshot().recent.length === 1);
		expect(client.inbox.getSnapshot()).toMatchObject({ status: "live", open: [] });

		stop();
		await until(() => FakeSocket.opened[1]?.closed === true);
		expect(states.length).toBeGreaterThan(3);
	});
});

describe("a message from a newer revision of the contract", () => {
	it("of a kind of ask the client doesn't know reads as unknown, and the rest as they are", async () => {
		const { fetch } = recording({
			[`GET /api/v1/snapshot`]: () =>
				Response.json({ open: [ask, { ...ask, id: "ask-2", kind: "poll" }], recent: [] }),
		});
		const client = createLoopbackClient({ baseUrl: "https://lb.test", token: "secret", fetch });
		const snapshot = await client.snapshot();
		expect(snapshot.open.map((item) => item.kind)).toEqual(["question", "unknown"]);
		expect(snapshot.open[1]).toMatchObject({ id: "ask-2", was: "poll" });
	});

	it("on the event socket, of a type the client doesn't know, is skipped", async () => {
		FakeSocket.opened.length = 0;
		const { fetch } = recording({
			[`POST /api/v1/events/tickets`]: () =>
				Response.json(
					{ ticket: "space.pass", expiresAt: "2026-01-01T00:01:00.000Z" },
					{ status: 201 },
				),
		});
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			token: "secret",
			fetch,
			WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
		});
		const stop = client.inbox.subscribe(() => undefined);
		await until(() => FakeSocket.opened.length === 1);
		const socket = FakeSocket.opened[0];
		socket?.receive({ type: "snapshot", snapshot: { open: [], recent: [] } });
		socket?.receive({ type: "ask.deleted", id: "ask-1" });
		socket?.receive({ type: "ask.opened", ask });
		await until(() => client.inbox.getSnapshot().open.length === 1);
		expect(client.inbox.getSnapshot()).toMatchObject({ status: "live", open: [{ id: "ask-1" }] });
		stop();
	});
});

describe("a body that isn't the contract", () => {
	it("is refused as invalid_body, not handed on as if it were", async () => {
		const { fetch } = recording({ [`GET /api/v1/whoami`]: () => Response.json({ nope: true }) });
		const client = createLoopbackClient({ baseUrl: "https://lb.test", token: "secret", fetch });
		const error = await client.whoami().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 200, code: "invalid_body" });
	});
});

describe("an update to Loopback under the client", () => {
	const whoami = { space: "default", actor: { id: "owner" } };
	const BUILD = "2026-11-01T10:00:00.000Z";
	const LATER = "2026-11-01T11:00:00.000Z";
	const EARLIER = "2026-11-01T09:00:00.000Z";

	/** A server whose answers name the version `serving` holds at the time. */
	const serving = (version: { build: string; revision?: number }) => {
		const answer = (body: unknown, status = 200) =>
			Response.json(body, {
				status,
				headers: {
					[REVISION_HEADER]: String(version.revision ?? REVISION),
					[BUILD_HEADER]: version.build,
				},
			});
		return {
			version,
			...recording({
				"GET /api/v1/whoami": () => answer(whoami),
				"POST /api/v1/events/tickets": () =>
					answer({ ticket: "space.pass", expiresAt: "2026-11-01T10:01:00.000Z" }, 201),
			}),
		};
	};

	it("names the revision the client writes on every request", async () => {
		const { calls, fetch } = serving({ build: BUILD });
		await createLoopbackClient({ baseUrl: "https://lb.test", fetch }).whoami();
		expect(new Headers(calls[0]?.init?.headers).get(REVISION_HEADER)).toBe(String(REVISION));
	});

	it("is offered once a later build answers, and required once a later revision does, for good", async () => {
		const server = serving({ build: BUILD });
		const client = createLoopbackClient({ baseUrl: "https://lb.test", fetch: server.fetch });
		const heard: Update[] = [];
		const stop = client.update.subscribe(() => heard.push(client.update.getSnapshot()));
		const after = async (version: { build: string; revision?: number }) => {
			Object.assign(server.version, version);
			await client.whoami();
			await new Promise((resolve) => setTimeout(resolve, 10));
			return client.update.getSnapshot();
		};
		expect(await after({ build: BUILD })).toBe("none");
		expect(await after({ build: BUILD })).toBe("none");
		// An isolate still finishing on the code from before is no update.
		expect(await after({ build: EARLIER })).toBe("none");
		expect(await after({ build: LATER })).toBe("available");
		expect(await after({ build: LATER, revision: REVISION + 1 })).toBe("required");
		expect(await after({ build: BUILD, revision: REVISION })).toBe("required");
		expect(heard).toEqual(["none", "available", "required"]);
		stop();
	});

	it("is required once the server refuses the client as from a newer revision", async () => {
		const { fetch } = recording({
			"GET /api/v1/whoami": () =>
				Response.json({ code: RELOAD_CODE, message: "Reload it." }, { status: 409 }),
		});
		const client = createLoopbackClient({ baseUrl: "https://lb.test", fetch });
		const stop = client.update.subscribe(() => undefined);
		const error = await client.whoami().catch((reason: unknown) => reason);
		expect(error).toMatchObject({ status: 409, code: RELOAD_CODE });
		await until(() => client.update.getSnapshot() === "required");
		stop();
	});

	it("is heard from the answer each connection of the event socket begins with", async () => {
		FakeSocket.opened.length = 0;
		const { fetch } = serving({ build: BUILD, revision: REVISION + 1 });
		const client = createLoopbackClient({
			baseUrl: "https://lb.test",
			fetch,
			WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
		});
		const following = client.inbox.subscribe(() => undefined);
		const stop = client.update.subscribe(() => undefined);
		await until(() => FakeSocket.opened.length === 1);
		await until(() => client.update.getSnapshot() !== "none");
		expect(client.update.getSnapshot()).toBe("required");
		stop();
		following();
	});
});
