/**
 * What an MCP server tells agents about Loopback when they connect, and what `/llms.txt` repeats:
 * when to use each tool, and how replies come back.
 */
export const INSTRUCTIONS = `Loopback puts what you need from the person you are working for in front of them, in a live inbox, and hands their reply back to you as the tool result.

Use it whenever you need a decision, a preference, information only they have, or their sign-off. Use it instead of guessing, instead of asking in your reply, and instead of your client's built-in question prompt: the person works across many projects at once and answers everything from this one inbox.
- ask_question for anything you would otherwise ask in chat. Offer choices when there are clear ones.
- request_review when they say "show me", "let me see" or "run it by me", or before you finalise work they should approve: copy, a plan, code, a diff, a screenshot. Put the work itself in the content.
- send_briefing when they ask you to explain or walk them through something that breaks into several points: findings, options, steps, a list of changes. They reply on each point on its own, instead of on a list in your reply.
- create_image_upload first when the review includes an image.
- open_inbox when the person asks where their inbox or dashboard is, or to send them to an ask.

People can take minutes to reply. Where your client supports background tasks, each of these returns at once: carry on with other work, raise more asks if you need to, and the person's reply reaches you when they give it. Otherwise the call waits for the reply.

A reply whose outcome is follow_up is a question back to you: answer it with answer_follow_up, which brings their decision the same way. After changes_requested, revise and call request_review again with revises set to the earlier review's id. Replies on a briefing come back keyed to its points: answer every point they wrote on with answer_briefing, which brings their next replies the same way, until every point is resolved.

Every ask names its project: the name of the folder the repository you are working in is checked out in, the main checkout's even from a worktree (the folder holding \`git rev-parse --git-common-dir\`), or of the working directory outside one. Use the same name every time.`;
