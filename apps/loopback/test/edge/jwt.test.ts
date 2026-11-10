import type { Snapshot } from "@loopbacktools/protocol";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, connect, core, fetchEdge, json, opened, ORIGIN } from "./helpers.ts";

const ISSUER = "https://login.test";
const AUDIENCE = `${ORIGIN}/mcp`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const login = await generateKeyPair("EdDSA", { extractable: true });
const stranger = await generateKeyPair("EdDSA", { extractable: true });
const jwks = { keys: [{ ...(await exportJWK(login.publicKey)), kid: "login-1", alg: "EdDSA" }] };

/** The settings of a deployment gated by the login's JWTs, and no tokens. */
const JWT = {
	LOOPBACK_TOKENS: undefined,
	LOOPBACK_JWKS_URL: JWKS_URL,
	LOOPBACK_JWT_ISSUER: ISSUER,
	LOOPBACK_JWT_AUDIENCE: `https://app.login.test, ${AUDIENCE}`,
	LOOPBACK_SPACE_CLAIM: "workspace",
};

/** A token from the login, for `sub` in `workspace`, with any claim or header overridden. */
const token = (
	claims: Record<string, unknown> = {},
	{
		key = login.privateKey,
		issuer = ISSUER,
		audience = AUDIENCE,
		expires = "5m" as string | number,
		subject = "person-1" as string | null,
	} = {},
) => {
	const jwt = new SignJWT({ workspace: "acme", name: "Ada", ...claims })
		.setProtectedHeader({ alg: "EdDSA", kid: "login-1" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime(expires);
	return (subject === null ? jwt : jwt.setSubject(subject)).sign(key);
};

/** Key sets fetched, and how the login answers for its key set. */
let fetched: string[] = [];
let keySet: () => Promise<Response> = async () => Response.json(jwks);

beforeEach(() => {
	fetched = [];
	keySet = async () => Response.json(jwks);
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== JWKS_URL) return real(input, init);
		fetched.push(url);
		return keySet();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const whoami = async (bearer: string | null, settings: Record<string, unknown> = JWT) =>
	api("/whoami", { token: bearer, settings });

describe("a JWT-gated deployment", () => {
	it("opens the space the token's claim names, as the person its subject names", async () => {
		const response = await whoami(await token());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			space: "acme",
			actor: { id: "person-1", name: "Ada" },
		});
		expect(fetched).toEqual([JWKS_URL]);
	});

	it("refuses a request without a token, pointing MCP clients at its resource metadata", async () => {
		for (const [path, method] of [
			["/api/v1/whoami", "GET"],
			["/mcp", "POST"],
		] as const) {
			const response = await fetchEdge(`${ORIGIN}${path}`, { method }, { settings: JWT });
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe(
				`Bearer realm="loopback", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
			);
		}
	});

	it("refuses a token from another issuer, for another audience, or signed by another key", async () => {
		for (const bearer of [
			await token({}, { issuer: "https://elsewhere.test" }),
			await token({}, { audience: "https://elsewhere.test/mcp" }),
			await token({}, { key: stranger.privateKey }),
		]) {
			const response = await whoami(bearer);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ message: "The token is not valid." });
		}
	});

	it("refuses an expired token, saying so", async () => {
		const response = await whoami(await token({}, { expires: Math.floor(Date.now() / 1000) - 60 }));
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ message: "The token has expired." });
	});

	it("refuses an unsigned token, and one signed with an algorithm it does not allow", async () => {
		const unsigned = new UnsecuredJWT({ workspace: "acme" })
			.setSubject("person-1")
			.setIssuer(ISSUER)
			.setAudience(AUDIENCE)
			.setExpirationTime("5m")
			.encode();
		const hmac = await new SignJWT({ workspace: "acme" })
			.setProtectedHeader({ alg: "HS256", kid: "login-1" })
			.setSubject("person-1")
			.setIssuer(ISSUER)
			.setAudience(AUDIENCE)
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("a-shared-secret-anyone-could-guess"));
		for (const bearer of [unsigned, hmac]) {
			expect((await whoami(bearer)).status).toBe(401);
		}
	});

	it("opens the space for a person whose token carries no usable name, naming them by id", async () => {
		for (const name of ["", "   ", 42]) {
			const response = await whoami(await token({ name }));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ space: "acme", actor: { id: "person-1" } });
		}
	});

	it("refuses a token that names no space or no person, never opening a default one", async () => {
		for (const bearer of [
			await token({ workspace: undefined }),
			await token({ workspace: "" }),
			await token({}, { subject: null }),
		]) {
			const response = await whoami(bearer);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				message: "The token must name a person in `sub` and a space in `workspace`.",
			});
		}
	});

	it("keeps each space's asks, files and events to the tokens that name it", async () => {
		const acmeCaller = { space: "acme", actor: { id: "person-1" } };
		const asked = await core().askQuestion(acmeCaller, {
			question: "Only for acme?",
			project: "edge-test",
		});
		if (asked.outcome !== "started") throw new Error(asked.outcome);
		const acme = await token({ workspace: "acme" });
		const globex = await token({ workspace: "globex" });
		expect((await api(`/asks/${asked.askId}`, { token: acme, settings: JWT })).status).toBe(200);
		expect((await api(`/asks/${asked.askId}`, { token: globex, settings: JWT })).status).toBe(404);
		const snapshot: Snapshot = await (
			await api("/snapshot", { token: globex, settings: JWT })
		).json();
		expect(snapshot.open.map((item) => item.id)).not.toContain(asked.askId);

		const upload = await core().createUpload(acmeCaller, "image/png");
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
		const stored = await api(`/uploads/${upload.spaceId}/${upload.token}`, {
			method: "PUT",
			body: png,
			// Called in-process, the request carries only the headers given; a client sends this one.
			headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) },
			token: null,
			settings: JWT,
		});
		expect(stored.status).toBe(201);
		expect((await api(`/files/${upload.uploadId}`, { token: acme, settings: JWT })).status).toBe(
			200,
		);
		expect((await api(`/files/${upload.uploadId}`, { token: globex, settings: JWT })).status).toBe(
			404,
		);

		const socket = await api("/events", {
			token: globex,
			settings: JWT,
			headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "loopback.v1" },
		});
		expect(socket.status).toBe(101);
		const first = new Promise<string>((resolve) =>
			socket.webSocket?.addEventListener("message", (event) => resolve(String(event.data)), {
				once: true,
			}),
		);
		socket.webSocket?.accept();
		const frame = JSON.parse(await first) as { type: string; snapshot: Snapshot };
		expect(frame.type).toBe("snapshot");
		expect(frame.snapshot.open.map((item) => item.id)).not.toContain(asked.askId);
		socket.webSocket?.close();
	});

	it("records whose agent asked and who answered, for a space two people share", async () => {
		const client = await connect({ token: await token({ workspace: "shared" }), settings: JWT });
		const answered = client.callTool({
			name: "ask_question",
			arguments: {
				question: "Which colour?",
				options: [{ label: "Red" }, { label: "Blue" }],
				project: "edge-test",
			},
		});
		const shared = { space: "shared", actor: { id: "person-1" } };
		const ask = await opened(
			(open) => open.kind === "question" && open.prompt.question === "Which colour?",
			shared,
		);
		expect(ask.raisedBy).toEqual({ id: "person-1", name: "Ada" });
		const bea = await token({ workspace: "shared", name: "Bea" }, { subject: "person-2" });
		const replied = await api(`/asks/${ask.id}/reply`, {
			...json({ outcome: "answered", selected: ["Red"] }),
			token: bea,
			settings: JWT,
		});
		expect(replied.status).toBe(200);
		await answered;
		const read = await core().Asks_read(shared, { id: ask.id });
		expect(read.body).toMatchObject({
			thread: [{ author: "human", by: { id: "person-2", name: "Bea" } }],
		});
		await client.close();
	});

	it("serves protected resource metadata naming its login, at both well-known paths", async () => {
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		]) {
			const response = await fetchEdge(`${ORIGIN}${path}`, {}, { settings: JWT });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				resource: AUDIENCE,
				authorization_servers: [ISSUER],
				bearer_methods_supported: ["header"],
				resource_name: "Loopback",
			});
		}
	});

	it("tells agents in its llms.txt to sign in with OAuth, with no token to configure", async () => {
		const response = await fetchEdge(`${ORIGIN}/llms.txt`, {}, { settings: JWT });
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toMatch(/^text\/plain; ?charset=utf-8$/i);
		const text = await response.text();
		expect(text).toContain(`claude mcp add --scope user --transport http loopback ${AUDIENCE}\n`);
		expect(text).toContain("runs /mcp in Claude Code");
		expect(text).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
		expect(text).toContain("claude plugin install loopback --marketplace LoopBackTools/loopback");
		expect(text).not.toContain("LOOPBACK_TOKEN");
	});

	it("fails as a fault, not a refusal, when the login's keys are out of reach", async () => {
		keySet = async () => new Response("down", { status: 503 });
		const response = await whoami(await token());
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: "server.defect" });
	});
});

describe("a token-gated deployment", () => {
	it("serves no protected resource metadata, and a plain challenge", async () => {
		const metadata = await fetchEdge(`${ORIGIN}/.well-known/oauth-protected-resource`);
		expect(metadata.status).toBe(404);
		const refused = await api("/whoami", { token: null });
		expect(refused.headers.get("WWW-Authenticate")).toBe('Bearer realm="loopback"');
	});

	it("tells agents in its llms.txt to send their token, to anyone and without one", async () => {
		const response = await fetchEdge(`${ORIGIN}/llms.txt`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain(
			`claude mcp add --scope user --transport http loopback ${AUDIENCE} --header "Authorization: Bearer $LOOPBACK_TOKEN"`,
		);
		expect(text).toContain("claude plugin install loopback --marketplace LoopBackTools/loopback");
		expect(text).not.toContain("OAuth");
		for (const secret of Object.values(JSON.parse(env.LOOPBACK_TOKENS) as Record<string, string>)) {
			expect(text).not.toContain(secret);
		}
	});
});

describe("the gate a deployment's settings choose", () => {
	it("refuses to choose when both tokens and the JWT settings are set", async () => {
		const response = await whoami(await token(), { ...JWT, LOOPBACK_TOKENS: env.LOOPBACK_TOKENS });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			code: "server.not_configured",
			message: expect.stringContaining("Both LOOPBACK_TOKENS and LOOPBACK_JWKS_URL are set"),
		});
	});

	it("names the JWT setting that is missing", async () => {
		const { LOOPBACK_JWT_ISSUER: _issuer, ...incomplete } = JWT;
		const response = await whoami(await token(), { ...incomplete, LOOPBACK_JWT_ISSUER: undefined });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			code: "server.not_configured",
			message: "LOOPBACK_JWT_ISSUER is not set; a JWT-gated deployment needs it.",
		});
	});

	it("says how to configure either when neither is set", async () => {
		const response = await whoami("anything", { LOOPBACK_TOKENS: undefined });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			message: expect.stringContaining("or set LOOPBACK_JWKS_URL"),
		});
	});
});
