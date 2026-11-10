# @loopbacktools/core

The [Loopback](https://github.com/LoopBackTools/loopback) core: every space's asks in a `Space`
Durable Object with its own SQLite database, their images in R2, and one `Core` entrypoint an edge
calls over a service binding. Every deployment builds it as it is; each owns the edge in front of it.

```sh
pnpm add @loopbacktools/core effect
```

## Deploying it

A whole core Worker is one line:

```ts
export { default, Core, Space } from "@loopbacktools/core";
```

Declare `Space` as a SQLite Durable Object, bind `FILES` to an R2 bucket, and declare
`CF_VERSION_METADATA`. Give it no route and no `workers.dev` address: its default export is `Core`,
so a public address would answer anyone. Loopback's own,
[`apps/loopback-core`](https://github.com/LoopBackTools/loopback/tree/main/apps/loopback-core), is
the example to copy.

## Calling it

`@loopbacktools/core/rpc` is what an edge imports: the core's RPC, `CoreRpc`, typed with
[`@loopbacktools/protocol`](https://www.npmjs.com/package/@loopbacktools/protocol)'s messages only,
and `operationsOf`, which picks the contract's operations off the binding for a router generated
from the contract.

```ts
import { operationsOf } from "@loopbacktools/core/rpc";

registerRoutes(app, () => operationsOf(env.CORE), deps);
const outcome = await env.CORE.askQuestion(caller, input, client, {
	budgetMs: 600_000,
	keepAliveMs: 25_000,
	progress: async (step) => notifyTheClient(step),
});
```

Every call takes the caller first, `{ space, actor: { id, name? } }`, which the edge's gate
established: the core has no gate of its own. The contract's operations answer with the status and
body the contract declares; the agent's operations answer with an outcome and the words agents are
given. A blocking call waits as long as its `Wait` allows, calling `progress` every `keepAliveMs`; a
`progress` that rejects means the caller has gone. `erase(space)` removes a tenant's asks, tickets
and images.

Deploy the core before its edge. A core serves edges at its own revision of the contract or older,
and `revision()` says which it speaks, so an edge can tell when it is the newer.

## Stability

Until 1.0, a minor release may change this package's API. Pin the minor version you build on.

MIT licensed.
