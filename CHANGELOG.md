# Changelog

## Unreleased

The inbox is redesigned for reading and answering, dark and light alike, with contrast well past the
minimum and no text under 14px. The list wraps titles instead of cutting them off, shows "Agent
waiting" only when an agent is, and opens the ask beside it as a tab. An ask reads top to bottom:
who asked, the question or title at headline size, its text and images, then numbered choices and a
labelled reply. Orange means one thing, that an agent is blocked on you. On a phone the reply sits
at the bottom of the screen: a composer that grows as you write, or a review's Request changes and
Approve, with rarer moves under a menu at the top. Commands to connect an agent wrap only between
their parts. The connection shows only while it is down.

For hosts built on `@loopbacktools/inbox` and `@loopbacktools/app`:

- `Inbox` takes a `header`, drawn at the top of the list. The app's header now goes there: the
  wordmark, notifications and the person's menu, which holds Connect an agent and Sign out.
- `Section` is a heading over its content, no longer a card; a dangerous one keeps its red edge.
- The app's styles set Loopback's type scale (14px at the smallest, 16px inputs) and colours on
  Kumo's tokens. A primary button marked `data-primary` takes the inverse text colour, so it reads on
  the light fill dark mode gives it.

## 0.7.1

- A task's agent stops showing as waiting once its poll takes the reply.
- A wait whose start fails is never counted as an agent waiting.
- A task poll can no longer be undone by the alarm ending the following it replaced.
- A wait socket's close is completed on compatibility dates before 2026-04-07 too.
- Converted tool schemas are frozen, so no request can change what the next one lists.

## 0.7.0

Agents' waits no longer keep a space awake. A blocking tool call waits in the Worker on a
hibernatable WebSocket to its space, which wakes only to say a reply landed; a task's presence is
stored with an alarm. Listen streams close at once, tool schemas convert to JSON Schema once per
isolate, and a deployment says which Workers plan it is on (`plan: "free" | "paid"`, default
`"paid"`), with a CPU check to run against a copy (see "Free or Paid" in the README).

For hosts built on `@loopbacktools/server`:

- The `Spaces` service gains `wait(access, askId, afterSeq)`. A layer that spreads the default
  `Spaces` carries it through; one built from scratch needs it.
- The space's `awaitReply` is gone. `takeReply(askId, afterSeq)` takes the reply to the agent's turn
  without waiting.
- `followTask` takes the poll intervals as an optional third argument.
- `createLoopback` takes `plan` and `budgets`.
