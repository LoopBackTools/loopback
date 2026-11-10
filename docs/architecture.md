# Architecture

```
 agent (Claude Code, …)              browser, or any frontend on the SDK
      │  MCP over HTTP                      │  REST + WebSocket
      ▼                                     ▼
 ┌──────────────────── edge: loopback (apps/loopback) ────────────────────┐
 │ routes and MCP tools generated from the contract (typespec-hono,        │
 │ typespec-http-mcp) · gate: LOOPBACK_TOKENS or JWT → { space, actor }    │
 │ /mcp · /api/v1/* · /api/v1/events · /llms.txt · the inbox               │
 └───────────────┬─────────────────────────────────────────────────────────┘
                 │ service binding CORE → entrypoint Core (Workers RPC)
                 │ CoreRpc: the contract's operations by id, the agent's
                 │ operations (with a wait and a progress callback),
                 │ fetch (event sockets, by ticket), erase, revision
                 ▼
 ┌──────────── core: loopback-core (@loopbacktools/core) ─────────────────┐
 │ no public address · Core: one runtime per environment                   │
 └───────────────┬──────────────────────────────┬──────────────────────────┘
                 ▼ RPC                           ▼
         Space Durable Object (SQLite)       R2 (images)
         asks, threads, upload tickets,
         waiting agents, connected inboxes
```

Every dependency points inward, towards the contract, and the root architecture test
(`scripts/architecture.test.ts`) holds each arrow:

```
protocol  ←  core  ←  apps/loopback-core
   ↑   ↖______________  apps/loopback's edge (@loopbacktools/core/rpc only)
  sdk  ←  inbox  ←  app  ←  apps/loopback's inbox
```

The core is built verbatim from `@loopbacktools/core` by every deployment, this one and any host's.
Each deployment owns its edge: the code it generates from the contract, its gate, its limits.

## Asks

An **ask** is what an agent needs from a person: a question, work to review, or a briefing. It is a
short thread. The agent's opening turn is the prompt; after that, the person's replies and the
agent's answers take turns, a turn being one entry or, for an agent answering a briefing, one entry
per point. An ask is `awaiting_human`, `awaiting_agent` (the agent owes an answer: to a question
asked back, or on a briefing's points) or `closed`. Every reply to a question or review except a
follow-up question closes it.

A **briefing** is points the agent explains, numbered `1`, `2`, `3` straight through its sections,
for the person to reply on one at a time. Their reply (`responded`) names points, each with words,
resolved, or both; the agent then owes an answer on every point written on and left unresolved, and
gives one thread entry per point, which may break the point into sub-points (`3.1`, then `3.1.2`,
three levels at most). Resolving a point resolves everything beneath it; writing on a point beneath
a resolved one reopens it. The briefing closes once every point is resolved, and the person may
dismiss it even while it is the agent's move. Where each point stands is never stored: one pure
fold, `foldBriefing` in the protocol package, reads it from the prompt and thread, and the server
validates with the same fold every inbox renders with.

## Spaces and the gate

Everything lives in a **space**: one `Space` Durable Object, addressed by name. The only part of
Loopback that decides who a request is from, and which space it opens, is the `Gate` service:

```ts
class Gate extends Context.Service<
	Gate,
	{
		readonly authenticate: (request: Request) => Effect.Effect<Access, Unauthorized>;
		readonly authorizationServers: Effect.Effect<ReadonlyArray<string>>;
	}
>()("loopback/Gate") {}
```

The gate is the edge's, and the core believes what its edge tells it: it has no public address, so
only the edge can call it. The deployment's settings choose between two gates. The token gate reads
`LOOPBACK_TOKENS`, a map from each person to their token, and opens the deployment's one space as
the person whose token it is; every entry is compared in constant time, all of them every time. The
JWT gate opens a space per tenant behind any login that issues JWTs: a token signed by
one of the login's keys opens the space a configured claim names, as the person in `sub`, and MCP
clients discover the login through the gate's `authorizationServers`. One deployment then serves
every tenant, each in its own Durable Object. [`hosting.md`](hosting.md) explains how to set it up.

A host builds its own edge in front of the core rather than wrapping a server: it calls the core's
RPC, `@loopbacktools/core/rpc`, with its own gate, limits and metering around each call. Inside the
core, the domain knows nothing else, the space (the `Space` object and its operations) knows only
the domain, and the core's own architecture test fails the build if any of it reaches outward.

## The contract

`packages/protocol/spec/main.tsp` is the single definition of every shape Loopback speaks: the REST
operations a frontend uses, the operations an agent calls, the frames the event socket sends, and the
messages each carries. `pnpm generate` produces, from it:

- framework-free types for clients and the core (`packages/protocol/src/generated`);
- the OpenAPI document, served at `/api/v1/openapi.json`;
- in each edge, the Hono routes, the MCP tools and the zod validators both use
  (`apps/loopback/src/generated`), each tool named by its operation id, titled by its summary and
  described by its doc, word for word.

Nothing generated is committed; `revisions/` keeps each revision of the contract frozen, and the
protocol's tests fail when a shape changes without a new one.

## The edge and the core

Both are written in Effect. The edge checks who is calling and hands each operation to the core, with
the caller (`{ space, actor }`) as the first argument. The inbox's operations go straight through:
the core answers each with the status and body the contract declares. The agent's go to the core's
agent operations, which wait for the person and answer in the words agents are given, the same
through every edge. A failure the core can't answer is thrown back over RPC, logged where it
happened, and the edge answers it as an incident to quote.

**What crosses the binding** is the core's RPC, `CoreRpc`, typed with the contract's messages only:
the contract's operations by id, `askQuestion` and the other agent operations with a `Wait` (a
budget, a keep-alive and a progress callback, which is a stub back into the edge), `createUpload`,
`fetch` for an inbox's socket by ticket, `erase` for a host removing a tenant, and `revision`.

**Deploy order and additive changes.** The core is deployed first, then the edge. A core serves edges
at its own revision of the contract or older, so a revision only adds, and a method an older edge
calls is never taken away (`packages/core/test/contract-freeze.test.ts`). An edge newer than its core
asks again for three seconds, then answers "deploy loopback-core first".

**Builds** are compared inside the core only: it calls each space as its own code, revision and
build, and a space on older code restarts onto newer. The edge names its own build on every answer,
for the inbox to notice it was updated.

A space's operations run inside its Durable Object and cross RPC as their `Exit`, encoded as JSON,
so a typed error raised in the object arrives intact in the core.

## Getting a reply to the agent

People take minutes to reply, and a call waits for them. `ask_question`, `request_review`,
`send_briefing`, `answer_follow_up` and `answer_briefing` hold their request open while the core waits
on a **wait socket**: a WebSocket from the core to the space at `/wait/<askId>`, which the space
accepts with the hibernation API. The space holds no timer and no request for the wait, so it can
sleep while the agent waits. When a reply lands, the space wakes and sends the socket one frame,
`reply`; the core then takes the reply with an RPC. Every 25 seconds the core pings the socket, which
the space's auto-response answers without waking it, and calls the edge's progress callback, which
sends an MCP progress notification, keeping clients' idle timers from giving up. A socket dropped
under a wait, by a restart or by the space moving onto new code, is opened again.

The core marks a reply delivered only once its own call has it, so a wait whose caller has gone
leaves the reply for the caller's retry: the edge's progress callback rejects once its client has
gone, and the core stops waiting at its next lap. Each lap costs about a millisecond of CPU, so a
deployment on Workers Free ends a wait after ten minutes with "no reply yet: call again with the same
arguments", and the call again rejoins the ask; on Paid a wait lasts until the reply. The wait's
budget is the edge's, which knows its plan and its clients.

Background tasks (the MCP Tasks extension) return once the tool generator supports them; until then,
every client waits.

Everything is stored in SQLite. The core's calls into a space are retried on a fresh
stub when Cloudflare marks a failure retryable, as a reset by a deploy is, and the operation is safe
to run twice; a reply is not, so a refused one is the inbox's to send again. While a wait socket is
open, the ask shows **agent waiting** in the inbox; when the last one closes, it shows at once that
the agent has gone. Replying is still possible, and the reply is
kept.

A retried call (the same question or review, from the same client and project) **rejoins** the ask
it opened, as long as an agent followed it within the last hour and it is still open or holds a
reply that never reached the agent. A dropped connection therefore never duplicates an ask or loses
a reply, while the same question asked again days later opens a fresh one.

## The inbox

The event socket (`/api/v1/events`) sends a snapshot of the space when it connects, then every
change. Browsers cannot set headers on a WebSocket, so an inbox first asks for a one-time ticket
(`POST /api/v1/events/tickets`, with its token in `Authorization`) and offers that as a subprotocol.
A ticket is spent on use and lapses within a minute, so the copy Cloudflare logs with the upgrade is
of no use; the token itself never leaves the header, which Cloudflare redacts. A client that can set
headers may instead send `Authorization` with the upgrade.
`@loopbacktools/sdk` wraps the REST calls and the socket, reconnects with backoff, and folds events
into an inbox state with a pure reducer. The web inbox, `@loopbacktools/inbox`, is built only on it: its
state is kept per client, so handing it another client follows another space, and which ask is
open is the host's to keep. `@loopbacktools/app` is the app around it, routed by path, which every
deployment composes with its own sign-in and workspaces; `apps/loopback` composes it with a token
sign-in. The edge hands an inbox's socket to the core with the ticket, and the core spends it.

## Images

`create_image_upload` mints a single-use ticket, valid for fifteen minutes, for one image type. The agent
uploads with `PUT` to the ticket's URL, which needs no credentials. The bytes stream into R2 at
exactly their declared length, so the size limit holds whatever the client claims. A review can show
only images its space holds.
