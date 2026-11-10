# Hosting Loopback for many people

One Loopback deployment can serve many tenants. Every space is its own Durable Object with its own
SQLite database, so tenants never share storage, and what decides which space a request opens is the
deployment's gate. The token gate opens a single space behind one secret. The JWT gate opens a space
per tenant behind any login that issues JWTs (your own, Better Auth, Auth0, WorkOS, Clerk, Cloudflare
Access), reading the space and the person from each token's claims.

Loopback ships no login of its own. People sign in to yours; Loopback checks what it issued.

## Point Loopback at your login

The JWT gate is chosen by its settings. None of them is a secret, so declare them as text in
`apps/loopback/cloudflare.config.ts`, in place of the token's secret:

```ts
env: {
	FILES: bindings.r2(),
	CF_VERSION_METADATA: bindings.versionMetadata(),
	LOOPBACK_JWKS_URL: bindings.text("https://login.example.com/.well-known/jwks.json"),
	LOOPBACK_JWT_ISSUER: bindings.text("https://login.example.com"),
	LOOPBACK_JWT_AUDIENCE: bindings.text("https://loopback.example.com/mcp"),
	LOOPBACK_SPACE_CLAIM: bindings.text("org_id"),
},
```

| Setting                 | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `LOOPBACK_JWKS_URL`     | Where your login publishes the keys it signs tokens with, as a JSON Web Key Set. |
| `LOOPBACK_JWT_ISSUER`   | The `iss` every token must carry. MCP clients are sent here to sign in.          |
| `LOOPBACK_JWT_AUDIENCE` | The audiences a token may be for, comma-separated. It must carry one in `aud`.   |
| `LOOPBACK_SPACE_CLAIM`  | The claim that names the space a token opens: an organisation or workspace id.   |
| `LOOPBACK_NAME_CLAIM`   | Optional. The claim holding the person's display name; `name` unless you say so. |

Set either `LOOPBACK_TOKEN` or the JWT settings, never both: a deployment with both, or neither,
answers every request with a 500 that says which to set.

Keep `CF_VERSION_METADATA` in every deployment, under that name (with Wrangler,
`"version_metadata": { "binding": "CF_VERSION_METADATA" }`). For a while after a deploy, a space can
go on running the code it started with while the new Worker calls it; with the deploy's version to
compare, such a space refuses the call and restarts onto the new code, and the Worker tries it again
([versioned messages](design/versioned-messages.md)). Every API response names the deploy in
`Loopback-Build`, which is how an open inbox learns that it can reload onto a newer one.

## What a token must carry

- A signature by one of the key set's keys, with EdDSA, ES256 or RS256. Unsigned tokens and shared
  secrets are refused.
- `iss`, `aud` and `exp`, checked against the settings and the clock.
- `sub`, the person. It becomes the actor Loopback records on what they ask and answer.
- The space claim, a non-empty string. A token without it is refused, never sent to a default space.

Everyone whose token names a space shares it: they see the same inbox, each ask records whose agent
raised it (`raisedBy`), and each reply records who gave it (`by`). An expired token is refused with a
message saying so, so a client knows to refresh it. If the key set cannot be fetched, the request
fails as a fault, not a refusal.

## Agents sign in with OAuth

With the JWT gate, Loopback is an OAuth protected resource, as the MCP specification asks. A refused
request carries a challenge naming its protected resource metadata (RFC 9728):

```
WWW-Authenticate: Bearer realm="loopback", resource_metadata="https://loopback.example.com/.well-known/oauth-protected-resource/mcp"
```

That document names your issuer as the authorization server, so an MCP client goes there to sign the
person in. Your login then needs to be an OAuth 2.1 authorization server: authorization server
metadata, PKCE with `S256`, client registration through Client ID Metadata Documents (or dynamic
client registration), and tokens issued for the resource the client asks for, so `aud` is
`https://<your deployment>/mcp`. Agents connect with no token to paste:

```sh
claude mcp add --scope user --transport http loopback https://loopback.example.com/mcp
claude plugin install loopback --marketplace LoopBackTools/loopback
```

then sign in with `/mcp` in Claude Code. The plugin holds only hooks, so it needs nothing for OAuth.
The deployment's `/llms.txt` says the same to agents: it is written for the way the gate signs agents
in, so an agent reading it on a JWT-gated deployment is told to use OAuth, and never asked for a
token.

The app this repository deploys signs in with a pasted credential, which suits the token gate.
Behind a login, compose [`@loopbacktools/app`](../packages/app/README.md) with your own sign-in and
workspaces, giving each workspace a client from [`@loopbacktools/sdk`](../packages/sdk/README.md)
whose `token` is a function that returns a fresh JWT; the SDK calls it for every request.

## Bring your own edge

A service that wraps Loopback, adding its own routes, billing or limits, writes its own edge in front
of the core rather than composing a server. It deploys the core as it is, from
[`@loopbacktools/core`](../packages/core), binds it as `CORE`, compiles
`@loopbacktools/protocol`'s spec with `typespec-hono` and `typespec-http-mcp`, and calls the core's
RPC, `@loopbacktools/core/rpc`, with its own gate, limits and metering around each call.
[`apps/loopback`](../apps/loopback) is the edge this repository deploys, and the one to start from.

## Upgrading

One deploy upgrades every tenant. A deploy resets each space's Durable Object; agents following
background tasks simply poll again, and a call waiting on a reply is retried on a fresh stub. Schema
migrations run in each space when it next starts, and only forward: a release that adds one cannot be
rolled back past it. Confirm a deployment from outside with `GET /api/v1/openapi.json`, which names
the release in `info.version`.
