# Contributing to Loopback

Thanks for helping. Bug reports, fixes and improvements are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened instead. Include
  the client you connected with and its version when the bug involves an agent.
- **Changes:** for anything larger than a small fix, open an issue first, so we can agree on the
  approach before you spend time on it.
- **Security issues:** never in a public issue. See [`SECURITY.md`](SECURITY.md).

## Setting up

You need Node 24.22 or later (or 22.23 or later) and pnpm 11.

```sh
pnpm install
cp apps/loopback/.dev.vars.example apps/loopback/.dev.vars
pnpm dev
```

`pnpm dev` serves the Worker and the inbox together, with hot reload, at the address Vite prints.
Sign in with the token in `.dev.vars`. Connect an agent to the same address's `/mcp` to try asks end
to end.

## The checks

A pull request has to pass what CI runs:

```sh
pnpm generate:check   # the generated API matches its TypeSpec definition
pnpm typecheck
pnpm lint             # oxlint, warnings included
pnpm format:check     # oxfmt; run `pnpm format` to fix
pnpm test
pnpm build
```

The server's tests run inside the Workers runtime through `@cloudflare/vitest-plugin`, against a
local Durable Object and R2 bucket. The SDK's and the inbox's run in Node.

## Changing the API

Every shape Loopback speaks is defined once, in `packages/protocol/spec/main.tsp`. To change one,
edit the definition, run `pnpm generate`, and commit the generated files with your change. Never
edit a `*.gen.ts` file or an OpenAPI document by hand: `pnpm generate:check` fails when they drift.

A change to a message's shape is a new revision of the contract. Parts of a deployment run
different code for a while after every deploy, so each names the revision it writes, and newer code
upgrades what is older ([versioned messages](docs/design/versioned-messages.md)). To make one:

1. Add the revision to the `Revisions` enum in the spec, and mark what changed with `@added`,
   `@removed`, `@renamedFrom` or `@typeChangedFrom`.
2. Run `pnpm generate`, then `pnpm --filter @loopbackhq/protocol freeze`, which freezes the new
   revision in `packages/protocol/revisions/`.
3. Write `packages/protocol/revisions/<n>.examples.json`: examples of the revision's messages,
   covering what changed. Every revision's examples must go on decoding with current code.
4. Point the protocol package's `./openapi.json` export at the new revision's document.

Readers decode with the Effect schemas `pnpm generate` writes from the spec
(`@loopbackhq/protocol/schema`), never by casting. Each union a release can grow ends in an
`unknown` member, so a reader meeting a message from a newer revision keeps what it can show.

The protocol's tests fail when a shape changes without a new revision, or a frozen one changes.
Changing only wording (descriptions, titles, examples) needs no revision.

## Code

- TypeScript throughout. The server and the SDK are written in
  [Effect](https://effect.website): typed errors, services as layers, and no unhandled promises.
- Formatting is oxfmt's (tabs, 100 columns). Don't hand-format around it.
- Comments say why, not what. Name things by what they mean to someone using Loopback.
- A change in behaviour comes with a test that fails without it.

## Commits and pull requests

- Keep a pull request to one change, with its tests and any docs it affects.
- Write the commit summary as what the change does, in the imperative ("Refuse an empty project"),
  and say why in the body.

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
