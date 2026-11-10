import { INSTRUCTIONS } from "./instructions.ts";

/** How agents sign in to a deployment: with OAuth through its login, or with its token. */
export type AgentSignIn = "oauth" | "token";

/** The marketplace the Claude Code plugin is installed from. */
const MARKETPLACE = "LoopBackTools/loopback";

/**
 * The deployment's `/llms.txt`: how an agent connects itself to this Loopback, then how to use it.
 * Each deployment writes its own, for the way its agents sign in, so an agent reading it is never
 * left to work out which of two cases it is in.
 */
export const llmsTxt = (origin: string, signIn: AgentSignIn): string => {
	const mcp = `${origin}/mcp`;
	const oauth = signIn === "oauth";
	return `# Loopback

> Loopback is the inbox where the person you work for answers you. You ask a question, put work in front of them for review, or walk them through something point by point; they answer from their inbox at ${origin}, across all their projects, and the reply comes back to you as the tool result. This deployment's MCP server is ${mcp}, over streamable HTTP, and ${oauth ? "agents sign in to it with OAuth, as the person, so there is no token to configure" : "agents send its token as a bearer header: the token the deployment was set up with, which only the person has"}.

## Connect Claude Code

There are two steps: add Loopback's MCP server, then install the plugin. Both take effect in sessions started afterwards.

1. Add the MCP server, named loopback, for the person (user scope):

\`\`\`sh
${
	oauth
		? `claude mcp add --scope user --transport http loopback ${mcp}`
		: `claude mcp add --scope user --transport http loopback ${mcp} --header "Authorization: Bearer $LOOPBACK_TOKEN"`
}
\`\`\`

${
	oauth
		? "Then the person runs /mcp in Claude Code, chooses loopback and signs in in their browser. Signing in is theirs to do: you cannot do it for them. If their login has several workspaces, they pick the one you ask in."
		: "Run it where LOOPBACK_TOKEN holds the token. Ask the person for it if you need it, and never write it into the repository or a file of the project."
}

2. Install the plugin:

\`\`\`sh
claude plugin install loopback --marketplace ${MARKETPLACE}
\`\`\`

The plugin needs no URL or token: it holds only hooks, which route every question to Loopback without the person having to ask for it. As a session starts it tells you to ask through Loopback and names the project; Claude Code's built-in question prompt is turned away to Loopback; and a turn that ends with a question in the conversation is sent back once, to ask it through Loopback. The hooks need jq and git.

## Connect another MCP client

Add ${mcp} as a remote MCP server over streamable HTTP. ${
		oauth
			? `It signs in with OAuth: the server's protected resource metadata is at ${origin}/.well-known/oauth-protected-resource/mcp, and names the login that authorises you.`
			: "Send the header Authorization: Bearer, then the token."
	}

## Using Loopback

${INSTRUCTIONS}

## More

- [The source, and how Loopback works](https://github.com/${MARKETPLACE})
- [The API, as OpenAPI](${origin}/api/v1/openapi.json)
`;
};
