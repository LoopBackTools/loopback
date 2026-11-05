import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The plugin's hooks, run as Claude Code runs them: a process given the event's JSON on stdin, in
 * real repositories, whose stdout is what Claude Code reads.
 */

const hooks = join(import.meta.dirname, "..", "hooks");

/** What a hook printed, parsed, or `undefined` when it printed nothing and let the event through. */
const run = (hook: string, input: object): Record<string, unknown> | undefined => {
	const result = spawnSync("bash", [join(hooks, hook)], {
		input: JSON.stringify(input),
		encoding: "utf8",
	});
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return result.stdout === "" ? undefined : (JSON.parse(result.stdout) as Record<string, unknown>);
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdio: "pipe",
	});

let root: string;
/** A repository's main checkout, a worktree of it elsewhere, and a folder in no repository. */
let checkout: string;
let worktree: string;
let loose: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "loopback-hooks-")));
	checkout = join(root, "acme");
	mkdirSync(join(checkout, "src"), { recursive: true });
	git(checkout, "init", "--quiet");
	git(checkout, "commit", "--quiet", "--allow-empty", "--message", "Start");
	worktree = join(root, "agent-a0102882");
	git(checkout, "worktree", "add", "--quiet", worktree);
	loose = join(root, "notes");
	mkdirSync(loose);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the project an ask names", () => {
	const projectFrom = (cwd: string) => {
		const output = run("ask-through-loopback.sh", { cwd });
		const hook = output?.["hookSpecificOutput"] as { permissionDecisionReason: string };
		return /project: "([^"]*)"/.exec(hook.permissionDecisionReason)?.[1];
	};

	it("is the folder the repository is checked out in, from anywhere inside it", () => {
		expect(projectFrom(checkout)).toBe("acme");
		expect(projectFrom(join(checkout, "src"))).toBe("acme");
	});

	it("is the main checkout's from a worktree, so one project is never two in the inbox", () => {
		expect(projectFrom(worktree)).toBe("acme");
	});

	it("is the working directory's outside a repository", () => {
		expect(projectFrom(loose)).toBe("notes");
	});
});

describe("as a session starts", () => {
	it("tells the agent to ask through Loopback's tools, naming the project", () => {
		const output = run("session-context.sh", { cwd: checkout, hook_event_name: "SessionStart" });
		const hook = output?.["hookSpecificOutput"] as Record<string, string>;
		expect(hook["hookEventName"]).toBe("SessionStart");
		expect(hook["additionalContext"]).toContain(`project: "acme"`);
		for (const tool of ["ask_question", "request_review", "send_briefing"]) {
			expect(hook["additionalContext"]).toContain(`${tool} tool`);
		}
		expect(hook["additionalContext"]).toContain("mcp__loopback__ask_question");
		expect(hook["additionalContext"]).not.toContain("mcp__plugin_loopback");
	});
});

describe("Claude Code's built-in question prompt", () => {
	it("is turned away, to ask through Loopback instead", () => {
		const output = run("ask-through-loopback.sh", { cwd: checkout, tool_name: "AskUserQuestion" });
		expect(output?.["hookSpecificOutput"]).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: expect.stringContaining("mcp__loopback__ask_question"),
		});
	});
});

describe("a turn that ends", () => {
	const stop = (message: string, more: object = {}) =>
		run("stop-if-asking.sh", { cwd: checkout, last_assistant_message: message, ...more });

	it.each([
		["a question", "Shall I deploy?"],
		["a question and what follows it", "Want me to render it? It'd be 1080 wide."],
		["a question in bold", "Is it **Monday 19 Oct**?"],
		["a question about some code", "Run `pnpm test`?"],
		["a question after the work", "The tests pass.\n\nShould I push?"],
		["a list of questions", "Two things:\n1. Which port?\n2. Which region?"],
		["a decision handed over", "That's your call."],
		["an offer to wait on", "Next is L1.5. Say the word and I'll start it."],
		["an offer, said plainly", "Say if you'd like the orange icon in the top bar too."],
		["a request for permission", "May I drive your Chrome for it"],
	])("asking %s is sent back to ask through Loopback", (_, message) => {
		expect(stop(message)).toEqual({
			decision: "block",
			reason: expect.stringMatching(/ask_question tool .*project: "acme"/),
		});
	});

	it.each([
		["with a statement", "Done. The tests pass."],
		["with a question asked earlier in it", "Should I?\n\nNo: the tests already cover it."],
		["with code holding a question mark", 'Run this:\n\n```\ncurl "$U/?x=1"\n```'],
		["with a link holding a question mark", "Open `http://localhost/cb?code=1` to finish."],
		["with a table cell that is only a question mark", "| Plan | ? |\n| --- | --- |"],
		["with a quoted question", "The draft:\n\n> Any questions? Just reply and let me know."],
		["with a question in a title", 'The "Invited to one?" line stays as it is.'],
		["saying what it's waiting on", "Waiting on your call in Loopback."],
		["empty", ""],
	])("%s is let stop", (_, message) => {
		expect(stop(message)).toBeUndefined();
	});

	it("is let stop when this hook already sent it back once, so it can never loop", () => {
		expect(stop("Shall I deploy?", { stop_hook_active: true })).toBeUndefined();
	});

	it.each([
		["the plugin's server", "plugin:loopback:loopback/ask_question"],
		["a server added as loopback", "loopback/request_review"],
		["a server added under another name", "inbox/send_briefing"],
		["a tool's full name", "mcp__loopback__answer_follow_up"],
	])("is let stop while a Loopback ask from %s waits in the background", (_, task) => {
		expect(stop("Shall I deploy?", { background_tasks: [{ description: task }] })).toBeUndefined();
	});

	it("is still sent back when a background task only mentions Loopback", () => {
		const tasks = [{ description: "pnpm dev in /Users/z/projects/loopback-cloud" }];
		expect(stop("Shall I deploy?", { background_tasks: tasks })).toMatchObject({
			decision: "block",
		});
	});
});
