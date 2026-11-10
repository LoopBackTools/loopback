# Hosting Loopback for many people

One Loopback deployment can serve many tenants. Every space is its own Durable Object with its own
SQLite database, so tenants never share storage, and what decides which space a request opens is the
deployment's gate. The token gate opens a single space to the people `LOOPBACK_TOKENS` names, each
with a token of their own. The JWT gate opens a space
per tenant behind any login that issues JWTs (your own, Better Auth, Auth0, WorkOS, Clerk, Cloudflare
Access), reading the space and the person from each token's claims.

Loopback ships no login of its own. People sign in to yours; Loopback checks what it issued.

## Point Loopback at your login

The JWT gate is chosen by its settings. None of them is a secret: set them in the environment of
every deploy, as you would `LOOPBACK_PLAN`, in place of `LOOPBACK_TOKENS`, and the edge declares them
as plain text:

```sh
LOOPBACK_JWKS_URL=https://login.example.com/.well-known/jwks.json \
LOOPBACK_JWT_ISSUER=https://login.example.com \
LOOPBACK_JWT_AUDIENCE=https://loopback.example.com/mcp \
LOOPBACK_SPACE_CLAIM=org_id \
pnpm run deploy
```

| Setting                 | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `LOOPBACK_JWKS_URL`     | Where your login publishes the keys it signs tokens with, as a JSON Web Key Set. |
| `LOOPBACK_JWT_ISSUER`   | The `iss` every token must carry. MCP clients are sent here to sign in.          |
| `LOOPBACK_JWT_AUDIENCE` | The audiences a token may be for, comma-separated. It must carry one in `aud`.   |
| `LOOPBACK_SPACE_CLAIM`  | The claim that names the space a token opens: an organisation or workspace id.   |
| `LOOPBACK_NAME_CLAIM`   | Optional. The claim holding the person's display name; `name` unless you say so. |

Set either `LOOPBACK_TOKENS` or the JWT settings, never both: the deploy refuses both, or a JWT
setting missing, before it deploys anything, with the words the edge would answer with. An edge
moving from tokens to a login has its `LOOPBACK_TOKENS` secret deleted first; the deploy says how.

Keep `CF_VERSION_METADATA` in both Workers, under that name. For a while after a deploy, a space can
go on running the code it started with while the new core calls it; with the core's version to
compare, such a space refuses the call and restarts onto the new code, and the core tries it again
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
of the core rather than composing a server. [`apps/loopback`](../apps/loopback) is the edge this
repository deploys, and the one to start from.

1. **Deploy the core as it is.** A core Worker is `export { default, Core, Space } from
   "@loopbacktools/core"`, with `Space` declared as a SQLite Durable Object, `FILES` bound to an R2
   bucket and `CF_VERSION_METADATA` declared ([`apps/loopback-core`](../apps/loopback-core)). Give it
   no route and no `workers.dev` address: its default export is `Core`, which would answer anyone.
2. **Compile the contract.** Import `@loopbacktools/protocol` from a `main.tsp` of your own and emit
   `typespec-hono` and `typespec-http-mcp` into one directory, with `seal-object-schemas` and the same
   options on both, `tool-tags: [Agent]` for the tools, and `@typespec/openapi3`'s `openapi-versions`
   set to `3.1.0` ([`apps/loopback/tspconfig.yaml`](../apps/loopback/tspconfig.yaml)).
3. **Hand the core to both surfaces.** Bind the core as `CORE`, entrypoint `Core`. The inbox's
   operations go straight through: `registerRoutes(app, () => ({ ...operationsOf(env.CORE), … }),
   deps)`, where `operationsOf` from `@loopbacktools/core/rpc` picks the contract's operations off
   the binding. The agent's operations call the core's `askQuestion` and the others with a `Wait`:
   how long the call may wait, how often to keep it alive, and a progress callback
   ([`apps/loopback/src/edge/agent.ts`](../apps/loopback/src/edge/agent.ts)).
4. **Write your gate.** It decides who each request is from and which space it opens, and passes
   that to the core as the caller, `{ space, actor: { id, name? } }`. The core has no gate of its own:
   it believes its edge.
5. **Meter or decline around the calls.** The handler object is yours: wrap any operation to count
   it against a tenant's plan, or answer before the core is called.
6. **Remove a tenant** with `env.CORE.erase(space)`, which deletes its asks, tickets and images, and
   finishes on a second run whatever a first left.

Agents should be told what this deployment's MCP server wants of them: set the server's instructions,
and serve an `/llms.txt`, as `apps/loopback` does.

## Bring your own head

The inbox is a head on [`@loopbacktools/sdk`](../packages/sdk/README.md), and you can bring your own:
the SDK is the REST calls, the live event socket and the inbox's state, with a promise API for any
framework and an Effect service, and knows nothing of React or of `@loopbacktools/inbox`.

## Upgrading

One deploy of the core upgrades every tenant; deploy the core first, then your edge. A deploy resets
each space's Durable Object, and a call waiting on a reply carries on through it. Schema
migrations run in each space when it next starts, and only forward: a release that adds one cannot be
rolled back past it. Confirm a deployment from outside with `GET /api/v1/openapi.json`, which names
the release in `info.version`.
