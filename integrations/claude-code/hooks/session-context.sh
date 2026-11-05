#!/usr/bin/env bash
# Tells the agent, as its session starts, that every question for the person goes through Loopback.
set -euo pipefail
source "$(dirname "$0")/project.sh"

input=$(cat)
project=$(project_of "$input")

context="The person answers everything from their Loopback inbox, across all their projects, not from this terminal. Whenever you need something from them, whether a clarifying question, a choice between approaches, a preference, permission to go ahead, or sign-off on work, ask with Loopback's ask_question tool or show the work with its request_review tool, with project: \"$project\". When they ask you to explain or walk them through something that breaks into several points (findings, options, steps, a list of changes), send it with its send_briefing tool so they can reply on each point, instead of writing the list in your reply. Do not ask in your reply and do not end a turn waiting for an answer in this conversation. Loopback's tools come from its MCP server: mcp__loopback__ask_question and the rest, where the server was added as loopback. If they are not in this session, ask in your reply instead, and tell the person Loopback's MCP server is not connected here."

jq -n --arg context "$context" '{
	hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $context }
}'
