import type { Ask, Reply } from "@loopbacktools/sdk";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskDetail, clientName } from "../src/detail.tsx";
import { Host } from "./host.tsx";

const base = {
	waiting: true,
	thread: [],
	project: "loopback",
	createdAt: "2026-10-27T10:00:00.000Z",
	updatedAt: "2026-10-27T10:00:00.000Z",
	status: "awaiting_human" as const,
};

const question: Ask = {
	...base,
	id: "q1",
	kind: "question",
	prompt: {
		question: "Which region first?",
		options: [{ label: "Europe" }, { label: "US East", description: "Closest to most users" }],
		multiple: false,
	},
};

const review: Ask = {
	...base,
	id: "r1",
	kind: "review",
	prompt: {
		title: "Landing copy",
		content: [{ type: "markdown", text: "Ask your agent anything." }],
	},
};

let sent: { url: string; reply: Reply }[] = [];

beforeEach(() => {
	sent = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		sent.push({ url, reply: JSON.parse(init?.body as string) });
		return Response.json({ ...question, status: "closed" });
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const show = (ask: Ask) =>
	render(
		<Host>
			<AskDetail ask={ask} />
		</Host>,
	);

describe("answering a question", () => {
	it("sends a picked choice with the note typed beside it", async () => {
		const user = userEvent.setup();
		show(question);
		await user.type(screen.getByRole("textbox"), "Most users are there");
		await user.click(screen.getByRole("button", { name: /US East/ }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.url).toMatch(/\/api\/v1\/asks\/q1\/reply$/);
		expect(sent[0]?.reply).toEqual({
			outcome: "answered",
			selected: ["US East"],
			text: "Most users are there",
		});
	});

	it("picks a choice by its number when the reply box is not focused", async () => {
		const user = userEvent.setup();
		show(question);
		await user.keyboard("1");
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "answered", selected: ["Europe"] });
	});

	it("asks back only with words to ask", async () => {
		const user = userEvent.setup();
		show(question);
		const askBack = screen.getByRole("button", { name: "Ask back" });
		expect(askBack).toBeDisabled();
		await user.type(screen.getByRole("textbox"), "What about latency?");
		await user.click(askBack);
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "follow_up", question: "What about latency?" });
	});
});

describe("reviewing work", () => {
	it("approves with the box's text as a note, from the keyboard", async () => {
		const user = userEvent.setup();
		show(review);
		await user.type(screen.getByRole("textbox"), "Ship it{Meta>}{Enter}{/Meta}");
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "approved", note: "Ship it" });
	});

	it("approves with ⌘↵ when nothing has focus, as a review that opens by itself has", async () => {
		const user = userEvent.setup();
		show(review);
		await user.keyboard("{Meta>}{Enter}{/Meta}");
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "approved" });
	});

	it("requests changes only with feedback", async () => {
		const user = userEvent.setup();
		show(review);
		const changes = screen.getByRole("button", { name: "Request changes" });
		expect(changes).toBeDisabled();
		await user.type(screen.getByRole("textbox"), "Warmer, please");
		await user.click(changes);
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "changes_requested", feedback: "Warmer, please" });
	});

	it("dismisses without words", async () => {
		const user = userEvent.setup();
		show(review);
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "dismissed" });
	});
});

/** A screen too narrow for the list and an ask side by side, as a phone's is. */
const onAPhone = () =>
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));

describe("whose move it is", () => {
	it("says the agent is waiting for an answer, only while it is", () => {
		show(question);
		expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
		cleanup();
		show({ ...question, waiting: false });
		expect(screen.queryByText("Waiting for your answer")).toBeNull();
	});

	it("says when the agent has the next move, and offers no reply", () => {
		show({ ...question, status: "awaiting_agent" });
		expect(screen.getByText("Waiting on the agent")).toBeInTheDocument();
		expect(
			screen.getByText("The agent has your question and will answer here."),
		).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).toBeNull();
	});
});

describe("who asked", () => {
	it("names the client as the person knows it, without its version", () => {
		expect(clientName("claude-code 2.0.31")).toBe("Claude Code");
		expect(clientName("cursor")).toBe("Cursor");
		expect(clientName("codex v0.4.2")).toBe("Codex");
	});

	it("says which agent asked, where, and when", () => {
		show({ ...question, client: "claude-code 2.0.31" });
		expect(screen.getByText(/^Claude Code in/)).toHaveTextContent(/Claude Code in loopback asked/);
	});
});

describe("answering on a phone", () => {
	it("approves a review in one tap, from the bottom of the screen", async () => {
		const user = userEvent.setup();
		onAPhone();
		show(review);
		expect(screen.queryByRole("textbox")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "approved" });
	});

	it("opens a box for the changes a review needs, and sends them", async () => {
		const user = userEvent.setup();
		onAPhone();
		show(review);
		await user.click(screen.getByRole("button", { name: "Request changes" }));
		const box = screen.getByRole("textbox", { name: "Requesting changes" });
		const send = screen.getByRole("button", { name: "Send changes" });
		expect(send).toBeDisabled();
		await user.type(box, "Warmer, please");
		await user.click(send);
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "changes_requested", feedback: "Warmer, please" });
	});

	it("backs out of requesting changes to the review's two moves", async () => {
		const user = userEvent.setup();
		onAPhone();
		show(review);
		await user.click(screen.getByRole("button", { name: "Request changes" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
	});

	it("answers a question in the person's own words, from the box at the bottom", async () => {
		const user = userEvent.setup();
		onAPhone();
		show(question);
		await user.type(
			screen.getByRole("textbox", { name: "Your answer, or a note" }),
			"Europe, then US East",
		);
		await user.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({
			outcome: "answered",
			selected: [],
			text: "Europe, then US East",
		});
	});

	it("dismisses from the menu at the top, where a rare move belongs", async () => {
		const user = userEvent.setup();
		onAPhone();
		show(question);
		expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitem", { name: "Dismiss" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "dismissed" });
	});
});

describe("an ask the inbox cannot draw", () => {
	it("says so, keeps the inbox up, and lets the person dismiss it", async () => {
		const user = userEvent.setup();
		const broken = { ...review, id: "r9", prompt: { title: "Saved half-way" } } as unknown as Ask;
		vi.spyOn(console, "error").mockImplementation(() => {});
		show(broken);
		expect(screen.getByText(/This ask can't be shown/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Inbox/ })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.url).toMatch(/\/api\/v1\/asks\/r9\/reply$/);
		expect(sent[0]?.reply).toEqual({ outcome: "dismissed" });
	});
});

describe("a message from a newer version of Loopback", () => {
	it("of a kind this page doesn't know says so, offers a reload, and can still be dismissed", async () => {
		const user = userEvent.setup();
		show({
			kind: "unknown",
			was: "poll",
			id: "u1",
			status: "awaiting_human",
			waiting: true,
			createdAt: "2026-10-27T10:00:00.000Z",
			updatedAt: "2026-10-27T10:00:00.000Z",
		});
		expect(screen.getByText(/This ask can't be shown/)).toBeInTheDocument();
		expect(screen.getByText(/newer version of Loopback than this page/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.reply).toEqual({ outcome: "dismissed" });
	});

	it("with a block this page doesn't know notes it in place, and shows the rest", () => {
		show({
			...review,
			prompt: {
				title: "Landing copy",
				content: [
					{ type: "markdown", text: "Ask your agent anything." },
					{ type: "unknown", was: "chart" },
				],
			},
		});
		expect(screen.getByText("Ask your agent anything.")).toBeInTheDocument();
		expect(screen.getByText(/can't be shown here/)).toBeInTheDocument();
	});

	it("with a reply this page doesn't know shows it in the thread as one", () => {
		show({
			...review,
			thread: [
				{
					author: "human",
					reply: { outcome: "unknown", was: "snoozed" },
					at: "2026-10-27T10:01:00.000Z",
				},
			],
		});
		expect(screen.getByText(/replied in a way this page can't show/)).toBeInTheDocument();
	});
});

describe("moving on", () => {
	it("tells the inbox once a reply has been sent, and not before", async () => {
		const user = userEvent.setup();
		const replied = vi.fn<() => void>();
		render(
			<Host>
				<AskDetail ask={review} onReplied={replied} />
			</Host>,
		);
		await user.type(screen.getByRole("textbox"), "Not yet");
		expect(replied).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(replied).toHaveBeenCalledTimes(1));
	});

	it("says loudly when a reply did not reach Loopback, and keeps the ask and its words", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		const user = userEvent.setup();
		const replied = vi.fn<() => void>();
		render(
			<Host>
				<AskDetail ask={review} onReplied={replied} />
			</Host>,
		);
		await user.type(screen.getByRole("textbox"), "Ship it");
		await user.click(screen.getByRole("button", { name: "Approve" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Your reply was not sent");
		expect(alert).toHaveTextContent("the agent still has nothing");
		expect(screen.getByRole("textbox")).toHaveValue("Ship it");
		expect(replied).not.toHaveBeenCalled();
	});
});

describe("an ask that is not the person's move", () => {
	it("offers no reply while the agent owes an answer", () => {
		show({ ...question, status: "awaiting_agent" });
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(
			screen.getByText("The agent has your question and will answer here."),
		).toBeInTheDocument();
	});
});

describe("a space people share", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith("/api/v1/whoami")) {
				return Response.json({ space: "acme", actor: { id: "person-1", name: "Ada" } });
			}
			return new Response(null, { status: 404 });
		});
	});

	it("says whose agent asked, and who replied, naming only other people", async () => {
		show({
			...review,
			status: "awaiting_human",
			raisedBy: { id: "person-2", name: "Bea" },
			thread: [
				{
					author: "human",
					reply: { outcome: "follow_up", question: "Which page?" },
					by: { id: "person-3", name: "Cal" },
					at: "2026-10-27T10:01:00.000Z",
				},
				{ author: "agent", answer: "The pricing page.", at: "2026-10-27T10:02:00.000Z" },
				{
					author: "human",
					reply: { outcome: "changes_requested", feedback: "Shorter." },
					by: { id: "person-1", name: "Ada" },
					at: "2026-10-27T10:03:00.000Z",
				},
			],
		});
		expect(await screen.findByText(/Bea's agent/)).toBeTruthy();
		expect(screen.getByText(/Cal asked/)).toBeTruthy();
		await waitFor(() => expect(screen.getByText(/You asked for changes/)).toBeTruthy());
	});

	it("does not name the person reading as the one whose agent asked", async () => {
		show({ ...question, raisedBy: { id: "person-1", name: "Ada" } });
		await waitFor(() => expect(screen.queryByText(/Ada's agent/)).toBeNull());
	});
});
