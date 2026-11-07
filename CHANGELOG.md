# Changelog

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
