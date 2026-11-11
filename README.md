<p align="center">
  <img src="docs/assets/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">Loopback</h1>

<p align="center">A human-in-the-loop inbox for coding agents.</p>

<p align="center">
  <a href="https://github.com/LoopBackTools/loopback/actions/workflows/ci.yml"><img src="https://github.com/LoopBackTools/loopback/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="Licence: MIT"></a>
</p>

When an agent needs a decision, a preference or your sign-off, it asks through Loopback instead of
guessing, or stopping in a terminal you are not watching. The ask appears in a live web inbox. You
answer there, and your reply comes back to the agent as the result of its tool call, so it carries
straight on.

Loopback is an MCP server on Cloudflare Workers, run on your own Cloudflare account as two Workers:
the core, which holds every inbox in a Durable Object of its own, and the edge in front of it, which
serves agents, the API and the inbox itself.

## Features

- **Questions and reviews.** Agents ask questions, with or without choices, and show you work for a
  verdict: copy, a plan, code, a diff, a screenshot.
- **Briefings, point by point.** When an agent explains something that breaks into several points,
  you reply on each point on its own, drill into it through sub-points the agent adds, and resolve
  it. Each point is one line until opened, so what still needs you is plain to see.
- **Ways to reply that fit the ask.** Answer (pick choices, write your own words, or both), approve
  with an optional note, request changes, ask a question back, reply on a briefing's points, or
  dismiss.
- **Agents wait as long as you need.** A call waits for your reply, kept alive by progress updates,
  however long you take.
- **One inbox for every project.** Each ask names the project it comes from, so agents in many
  repositories share one inbox.
- **Nothing lost.** Asks and replies live in SQLite. A call retried after a dropped connection
  rejoins the ask it opened, and a reply waits for the agent that asked.
- **A live inbox.** Grouped by whose turn it is, updated as agents ask, with keyboard shortcuts and
  opt-in notifications.
- **Claude Code plugin.** Routes every question Claude Code has for you to Loopback, without your
  having to ask it to.
- **Spec-first API.** The REST API, event socket and MCP tools are defined once in TypeSpec, and
  the edge's routes and tools are generated from it, with a typed SDK for building your own inbox.
- **Friends in your inbox.** Give each person a token of their own, and see whose agent asked what.

## Tools

| Tool                  | What it does                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `ask_question`        | Asks you something, optionally with choices.                                            |
| `request_review`      | Shows you work for your verdict: approve, request changes, ask back or dismiss.         |
| `answer_follow_up`    | Answers a question you asked back, keeping the same ask open.                           |
| `send_briefing`       | Explains something as points you reply on one at a time, and resolve.                   |
| `answer_briefing`     | Answers your replies on a briefing, point by point, breaking points into sub-points.    |
| `create_image_upload` | Hands out a one-time URL for an image to show in a review.                              |
| `open_inbox`          | Gives the address of your inbox, or of one ask in it, so the agent can open it for you. |

The edge tells agents when to use each tool, so asking an agent to "show me the copy" or "check
with me before you pick" is enough.

## Quick start

You need a Cloudflare account with R2 enabled, Node 24.22 or later (or 22.23 or later), and pnpm 11.
Loopback deploys with [`cf`](https://developers.cloudflare.com/cf/), Cloudflare's CLI, which is in
beta; `pnpm install` installs it for you.

```sh
git clone https://github.com/LoopBackTools/loopback.git
cd loopback
pnpm install
pnpm --filter ./apps/loopback exec cf auth login
printf 'LOOPBACK_TOKENS={"owner":"%s"}\n' "$(openssl rand -hex 32)" > ~/loopback.secrets
pnpm run deploy --secrets-file ~/loopback.secrets
```

The deploy creates two Workers: `loopback-core`, which holds your inbox and its images and has no
public address, then `loopback` in front of it, with your token as its secret. It prints what it
found and what it is about to do first; `pnpm run deploy --dry-run` stops there.

Open the `workers.dev` URL the deploy printed, and sign in with the token from `~/loopback.secrets`.
Keep the token somewhere safe, such as a password manager, then delete the file. Each token must be
at least 32 characters, and it only ever travels in the `Authorization` header, which Cloudflare
keeps out of its logs.

Later deploys keep the tokens, so `pnpm run deploy` is enough. Always deploy with it, never with
`cf deploy` in one app's folder: it deploys the core before the edge, and keeps the core's bucket.

## Give someone access

`LOOPBACK_TOKENS` is a map from each person to their token. To let a friend in, add them with a
token of their own, from `openssl rand -hex 32`, and deploy with the file again:

```sh
LOOPBACK_TOKENS={"owner":"<your token>","ada":"<ada's token>"}
```

Each token opens the same inbox as that person: an ask names whose agent raised it, and a reply who
gave it. To take someone's access away, delete their entry and deploy again. A map Loopback can't
trust (empty, a token under 32 characters, one character repeated, or two people sharing a token) is
refused before anything is deployed, naming the person and never the token.

## Upgrade, move or remove

**From 0.7.** A 0.7 deployment is one Worker holding your inbox. `pnpm run deploy` moves it into the
core without copying anything: the core takes over the Worker's Durable Object namespace in
Cloudflare's transfer, with every ask and id intact, and binds its bucket of images. Put your old
token in `LOOPBACK_TOKENS` under `owner`, so your agents and the plugin carry on unchanged:

```sh
printf 'LOOPBACK_TOKENS={"owner":"%s"}\n' "<your current token>" > ~/loopback.secrets
pnpm run deploy --secrets-file ~/loopback.secrets
```

A deploy that stops partway, for whatever reason, finishes when you run it again: each step is safe
to repeat, and the deploy reads what the account holds before it plans.

**Under another name.** Set `LOOPBACK_NAME` on every deploy to run a deployment as `<name>` and
`<name>-core`, beside another on the same account.

**Remove it.** Delete both Workers, the edge first. Each asks you to confirm, and deleting the core
deletes every ask in it:

```sh
pnpm --filter ./apps/loopback exec cf workers delete loopback
pnpm --filter ./apps/loopback exec cf workers delete loopback-core
```

Then empty the core's bucket and delete it. A bucket that still holds images can't be deleted:

```sh
bucket=loopback-core-files
keys=$(pnpm --filter ./apps/loopback exec cf r2 objects list --bucket-name $bucket | jq -c 'map(.key)')
pnpm --filter ./apps/loopback exec cf r2 objects bulk-delete --bucket-name $bucket --body "$keys"
pnpm --filter ./apps/loopback exec cf r2 buckets delete $bucket
```

The bucket is `loopback-files` for a deployment upgraded from 0.7, and `loopback-core-files` for one
installed fresh. The list comes a page at a time, so repeat the `keys=` and `bulk-delete` lines until
it is empty before you delete the bucket.

## Free or Paid

Loopback is built to run on Cloudflare's Workers Free plan, which holds each request to 10 ms of
CPU. Most of its requests take 2 to 9 ms. The first request a fresh isolate serves, and a blocking
question, take 20 to 65 ms: a copy held to 10 ms on Workers Paid let every one of them through,
but Free itself hasn't been measured. A deployment says which plan it is on with `LOOPBACK_PLAN`
when it is deployed:

```sh
LOOPBACK_PLAN=paid pnpm run deploy
```

Set it on every deploy: a deploy without it is for Free, and says so. The two differ only in how long
an agent's call waits for you: on Free, 10 minutes, after which the agent is told to call again with
the same arguments, which picks up the same question; on Paid, until you answer.

To check that a change fits Free, deploy a copy held to Free's 10 ms of CPU per request, drive it
with an agent's traffic, and read back what each request cost:

```sh
pnpm --filter ./apps/loopback exec cf deploy --mode cpu-check --secrets-file ~/loopback.secrets
LOOPBACK_URL=https://loopback-cpu-check.<your-subdomain>.workers.dev LOOPBACK_TOKEN=... \
  node apps/loopback/scripts/cpu-check.ts
CLOUDFLARE_ACCOUNT_ID=<your account id> \
  pnpm --filter ./apps/loopback exec node scripts/cpu-report.ts loopback-cpu-check <when the check began>
```

The copy is an edge in front of your own core. Delete it afterwards with
`pnpm --filter ./apps/loopback exec cf workers delete loopback-cpu-check`.

## Connect an agent

### Claude Code

Add Loopback's MCP server, for every project, with your own token from `LOOPBACK_TOKENS` in the
environment variable `LOOPBACK_TOKEN`:

```sh
claude mcp add --scope user --transport http loopback https://<your-worker>/mcp \
  --header "Authorization: Bearer $LOOPBACK_TOKEN"
```

Then install the plugin, which routes every question the agent has for you to Loopback without your
having to ask it to. It holds only hooks, so it needs no URL or token:

```sh
claude plugin install loopback --marketplace LoopBackTools/loopback
```

[`integrations/claude-code`](integrations/claude-code/README.md) explains what it does. Or let the
agent do it: every deployment serves `/llms.txt`, which tells an agent how to connect itself to that
deployment, for the way its agents sign in, and how to use Loopback once it has.

### Any MCP client

Loopback serves MCP over Streamable HTTP at `/mcp`, authenticated with your token as a bearer
header. Most clients take a configuration like this:

```json
{
	"mcpServers": {
		"loopback": {
			"type": "http",
			"url": "https://<your-worker>/mcp",
			"headers": { "Authorization": "Bearer <your-token>" }
		}
	}
}
```

Behind a login, through the JWT gate, agents sign in with OAuth instead and need no token in their
configuration: [`docs/hosting.md`](docs/hosting.md) explains it.

Every call that brings your reply waits for it, which can take minutes. Loopback sends a progress
update every 25 seconds to keep the call alive, so a client that resets its timeout on progress, as
Claude Code does, waits as long as it takes; one that caps tool calls at a fixed timeout needs that
limit raised. Background tasks (`io.modelcontextprotocol/tasks`), which let an agent carry on while
it waits, return once the generator Loopback's tools are built with supports them.

## How it works

The edge authenticates each request and calls the core over a service binding. The core hands it to
a `Space` Durable Object, which holds the asks, their threads and the connected inboxes in SQLite,
and keeps images in R2. Agents reach the edge through MCP; the inbox through a REST API and an event
socket. Both the edge's routes and its MCP tools are generated from one TypeSpec contract.
[`docs/architecture.md`](docs/architecture.md) explains how it fits together.

## Build your own inbox

The whole web app is published as [`@loopbacktools/app`](packages/app/README.md): compose it with your
own sign-in and workspaces, and it brings the inbox, its header, routing and the page on connecting
agents. The inbox alone is published as React components, [`@loopbacktools/inbox`](packages/inbox/README.md),
to render inside an app of your own: it reads and answers through the client you hand it, and moves
between asks through your routes. It is built only on `@loopbacktools/sdk`, a client for the REST
calls, the live event socket and the inbox state, with a promise API for any framework and an
Effect service, which [`packages/sdk`](packages/sdk/README.md) explains. The API is also described
by an OpenAPI document, served at `/api/v1/openapi.json`, for clients in any language.

## Bring your own login

Instead of tokens, the edge can take JWTs from any login that issues them: Cloudflare Access, your
own, Better Auth, Auth0, WorkOS or Clerk. Set `LOOPBACK_JWKS_URL` and the other JWT settings in the
environment of every deploy, in place of `LOOPBACK_TOKENS`, and agents sign in with OAuth, with no
token to configure.
[`docs/hosting.md`](docs/hosting.md) explains the settings.

## Hosting for many people

One deployment can serve many tenants. Point its JWT gate at any login that issues JWTs, and each
token's claims name the space it opens and the person; every space is its own Durable Object, and
agents sign in with OAuth. [`docs/hosting.md`](docs/hosting.md) explains how.

## Development

```sh
cp apps/loopback/.dev.vars.example apps/loopback/.dev.vars
pnpm generate         # the code generated from the TypeSpec definition, which git doesn't keep
pnpm dev              # the edge, its core and the inbox, with hot reload
pnpm test             # every package's tests, and the rules every dependency keeps
pnpm lint             # oxlint
pnpm typecheck
pnpm format           # oxfmt
```

| Path                       | What it is                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/protocol`        | The API contract, in TypeSpec, and what is generated from it: types and the OpenAPI document.    |
| `packages/core`            | The core: the `Space` Durable Object, stored images, and the RPC an edge calls, in Effect.       |
| `packages/sdk`             | A client for building your own inbox, in any framework.                                          |
| `packages/inbox`           | The web inbox as React components, built on the SDK.                                             |
| `packages/app`             | The web app around the inbox, for a deployment to compose with its own sign-in.                  |
| `apps/loopback`            | The deployable edge, generated from the contract, in front of the core, and the inbox it serves. |
| `apps/loopback-core`       | The deployable core: `@loopbacktools/core` as it is, with no public address.                     |
| `integrations/claude-code` | The Claude Code plugin.                                                                          |

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setting up, the
checks a change has to pass, and changing the API.

## Security

Please report vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes, not in a public
issue.

## Licence

[MIT](LICENSE)
