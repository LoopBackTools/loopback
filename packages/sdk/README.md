# @loopbacktools/sdk

Everything a frontend needs to read and answer what agents ask through Loopback: the REST calls,
the live event socket with reconnects, and the inbox state kept current from it.

It comes in two forms over one implementation: a promise client for any framework, and an Effect
service.

```sh
pnpm add @loopbacktools/sdk
```

The inbox, [`@loopbacktools/inbox`](https://www.npmjs.com/package/@loopbacktools/inbox), is built only on
this SDK, so it is a full example to work from, or a set of components to use as they are.

## Promise client

```ts
import { ApiError, createLoopbackClient } from "@loopbacktools/sdk";

const loopback = createLoopbackClient({
	baseUrl: "https://loopback.example.workers.dev",
	token: "…", // or a function returning a fresh one
});

const { open } = await loopback.snapshot();

try {
	await loopback.reply(open[0].id, { outcome: "approved", note: "Ship it" });
} catch (error) {
	if (error instanceof ApiError) console.log(error.status, error.code, error.message);
}
```

Replies are one of:

| `outcome`           | Fields                                  | For                           |
| ------------------- | --------------------------------------- | ----------------------------- |
| `answered`          | `selected: string[]`, `text?`           | questions                     |
| `approved`          | `note?`                                 | reviews                       |
| `changes_requested` | `feedback`                              | reviews                       |
| `follow_up`         | `question` — keeps the ask open         | questions, reviews            |
| `responded`         | `points: { point, text?, resolved? }[]` | briefings                     |
| `dismissed`         |                                         | questions, reviews, briefings |

A briefing's points, and where each stands, are folded from its prompt and thread by
`foldBriefing(ask.prompt, ask.thread)`: the tree an inbox renders, the points that need the person,
and those the agent owes an answer on. `respondedProblem` says why a `responded` reply would be
refused before it is sent.

`loopback.file(uploadId)` fetches an image a review shows, as a `Blob`.

### The live inbox

`loopback.inbox` is an external store. It connects when its first listener subscribes and
disconnects after its last one leaves.

```tsx
import type { Ask } from "@loopbacktools/sdk";
import { useSyncExternalStore } from "react";

const titleOf = (ask: Ask) => {
	switch (ask.kind) {
		case "question":
			return ask.prompt.question;
		case "review":
		case "briefing":
			return ask.prompt.title;
		case "unknown":
			return "Reload to see this ask";
	}
};

function Inbox() {
	const inbox = useSyncExternalStore(loopback.inbox.subscribe, loopback.inbox.getSnapshot);
	return (
		<ul>
			{inbox.open.map((ask) => (
				<li key={ask.id}>{titleOf(ask)}</li>
			))}
		</ul>
	);
}
```

`InboxState` holds `status` (`connecting`, `live` or `reconnecting`), `open` (newest first) and
`recent` (most recently closed first). `awaitingHuman(state)` picks the asks waiting on the person.

### Updates

`loopback.update` is an external store too, saying whether Loopback has been updated under the page,
as every response tells the client, the one each socket connection begins with included:

- `none`: the page's code is level with the server's.
- `available`: a later deploy of the same revision of the contract answers. Offer a reload.
- `required`: the server writes a later revision of the contract than this client reads, or refused
  the client as newer than itself, as it does after a rollback. Reload: asks may arrive that this
  page can't draw, and what it sends may be refused.

It never goes back. Reload when it's safe for the person, such as when the page is hidden, rather
than under someone typing.

## Effect

```ts
import { LoopbackClient } from "@loopbacktools/sdk";
import { Effect, Stream } from "effect";

const program = Effect.gen(function* () {
	const loopback = yield* LoopbackClient;
	yield* loopback.inbox.pipe(Stream.runForEach((state) => Effect.log(`${state.open.length} open`)));
});

program.pipe(
	Effect.provide(LoopbackClient.layer({ baseUrl: "https://…", token: "…" })),
	Effect.runFork,
);
```

`events` is the raw stream of socket frames, and `applyEvent` is the reducer `inbox` is built on,
for anyone keeping their own state. `update` is the stream of `Update`s, starting with the current
one.

## Types

Every type the API speaks (`Ask`, `Reply`, `Block`, `Snapshot`, …) is re-exported, generated from
the API's TypeSpec definition. The client decodes everything it receives against them rather than
trusting it, and refuses a body that isn't the contract as an `ApiError` with the code
`invalid_body`.

A deployment can run a newer revision of the contract than the code that reads it, so each union a
release can grow ends in an `unknown` member: an `Ask` of kind `unknown`, a `Block` of type
`unknown`, a `Reply` with the outcome `unknown`. Each keeps what can still be shown and what it was
(`was`). An exhaustive `switch` has to handle it, and the compiler says so. Socket frames of a type
the client doesn't know are skipped. What a reply sends is `ReplyBody`.
