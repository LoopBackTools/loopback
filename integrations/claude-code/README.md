# Loopback for Claude Code

A Claude Code plugin that routes every question the agent has for you to your Loopback inbox,
without your having to ask it to. Three hooks cover the ways an agent asks:

- **When a session starts**, the agent is told that you answer from Loopback, and to put every
  question, choice, request for permission or piece of work to sign off there, naming the project.
- **Claude Code's built-in question prompt** is turned away, and the agent asks through Loopback
  instead.
- **A turn that ends with a question in the conversation** is sent back once, to ask it through
  Loopback. A turn whose question is already waiting in Loopback is left alone.

Every ask names its project the same way: the folder the session's repository is checked out in,
the main checkout's from a worktree, so one project never appears in the inbox under two names.

## Install

The plugin holds only the hooks. The connection to Loopback is Claude Code's own MCP server, added
once for every project, so the plugin needs no URL, token or sign-in, whichever way your deployment's
agents sign in:

```sh
# A deployment with a token: with the token in LOOPBACK_TOKEN.
claude mcp add --scope user --transport http loopback https://<your-worker>/mcp \
  --header "Authorization: Bearer $LOOPBACK_TOKEN"
# A deployment behind a login: then run /mcp in Claude Code and sign in.
claude mcp add --scope user --transport http loopback https://<your-deployment>/mcp

claude plugin install loopback --marketplace LoopBackTools/loopback
```

Your deployment's `/llms.txt` gives an agent the same steps, written for that deployment, and its
inbox's _Connect an agent_ page gives them to you. With several Claude Code accounts, run both
commands once for each, with `CLAUDE_CONFIG_DIR` set to that account's directory. The hooks take
effect in sessions started afterwards; they need `jq` and `git` on your PATH.

The hooks name Loopback's tools as `mcp__loopback__*`, the names they have when the server is added
as `loopback`, and recognise them by their own names under any other.

### From 0.4 and earlier

Until 0.5.0 the plugin connected to Loopback itself, with the URL and token it was configured with.
After updating it, add the MCP server as above, once for each account: the plugin no longer
connects, and the token it was configured with is no longer used.

## Tests

`pnpm test` runs each hook as Claude Code does, with the event's JSON on stdin, in real
repositories and worktrees.
