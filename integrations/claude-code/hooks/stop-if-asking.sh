#!/usr/bin/env bash
# When the agent ends its turn by asking the person something in the conversation, sends it back to
# ask through Loopback instead, where the person is answering.
set -euo pipefail
source "$(dirname "$0")/project.sh"

input=$(cat)

# Already continuing because of this hook: let it stop, so it can never loop.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
# A Loopback ask is already waiting in the background: the question has been asked. Its tools are
# matched by name, as `server/tool` or `mcp__server__tool`, whatever the server was added as.
jq -e '.background_tasks // [] | tostring
	| test("(/|__)(ask_question|request_review|send_briefing|answer_follow_up|answer_briefing)\\b")' \
	<<<"$input" >/dev/null && exit 0

# Whether the last paragraph of the agent's final message asks the person something. Code and quoted
# text are someone else's words, not the agent's: a fenced block goes, inline code reads as a word,
# and a quoted line goes. A sentence asks when it ends in a question mark (a lone `?` in a table cell
# or `?code=` in a URL doesn't), or when it hands the person a decision in so many words.
asks='\S\?([*_)]*\s|[*_)"'"'"']*(\n|$))'
asks+='|\blet me know\b|\btell me (which|what|if|whether|how)\b|\bwhich (one|option|would you)\b'
asks+='|\b(do|would) you (want|like|prefer|rather)\b|\bwant me to\b|\b(should|shall|may) I\b'
asks+='|\bsay the word\b|\bsay (so )?if you\b|\b(it'"'"'?s|that'"'"'?s) your call\b'
jq -e --arg asks "$asks" '
	.last_assistant_message // ""
	| gsub("```[\\s\\S]*?```"; "")
	| gsub("`[^`\n]*`"; "code")
	| [splits("\n")] | map(select(test("^\\s*>") | not)) | join("\n")
	| [splits("\n[ \t]*\n")] | map(select(test("\\S"))) | last // ""
	| test($asks; "i")' <<<"$input" >/dev/null || exit 0

project=$(project_of "$input")
reason="You ended your turn asking the person something in this conversation, but they answer from their Loopback inbox, not this terminal. Put that question to them with Loopback's ask_question tool (mcp__loopback__ask_question, where its MCP server was added as loopback), with any choices you offered as options and project: \"$project\" (or show the work with its request_review tool if you are asking them to look at something, or send the points with its send_briefing tool if you were explaining several). If Loopback's tools are not in this session, you may stop."

jq -n --arg reason "$reason" '{ decision: "block", reason: $reason }'
