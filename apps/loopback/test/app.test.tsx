import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/app.ts";
import { tokenAtom } from "../src/web/session.ts";

const TOKEN = "a-token-of-at-least-thirty-two-characters";

/**
 * A server that opens the default space for the right token, and for no token at all when `vouched`,
 * as a Worker in front that signs its callers in does. It refuses everything else.
 */
const serving = ({ vouched }: { vouched: boolean }) => {
	const seen: { url: string; authorization: string | null }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const authorization = new Headers(init?.headers).get("Authorization");
		seen.push({ url, authorization });
		const accepted = authorization === `Bearer ${TOKEN}` || (vouched && authorization === null);
		return url.endsWith("/api/v1/whoami") && accepted
			? Response.json({ space: "default", actor: { id: "owner" } })
			: Response.json({ code: "auth.unauthorized", message: "No." }, { status: 401 });
	});
	return seen;
};

/** The app at `path`, holding `token`. */
const open = (path: string, token: string | null) => {
	window.history.replaceState(null, "", path);
	render(
		<RegistryProvider initialValues={[[tokenAtom, token]]}>
			<App />
		</RegistryProvider>,
	);
};

const here = () => `${window.location.pathname}${window.location.hash}`;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("the self-hosted app", () => {
	it("opens the inbox at once when the page's host has signed the person in", async () => {
		const user = userEvent.setup();
		const seen = serving({ vouched: true });
		open("/", null);
		expect(await screen.findByText("Connecting")).toBeInTheDocument();
		expect(here()).toBe("/w/default");
		expect(screen.queryByLabelText("Token")).toBeNull();
		// The host owns the session, so there is nothing here to sign out of.
		await user.click(await screen.findByRole("button", { name: "Account" }));
		expect(await screen.findByRole("menuitem", { name: "Connect an agent" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
		expect(seen.find((call) => call.url.endsWith("/whoami"))?.authorization).toBeNull();
	});

	it("takes the token, opens the ask a link named, and forgets the token on signing out", async () => {
		const user = userEvent.setup();
		serving({ vouched: false });
		open("/w/default/asks/ask-1", null);
		await user.type(await screen.findByLabelText("Token"), TOKEN);
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() => expect(here()).toBe("/w/default/asks/ask-1"));
		expect(localStorage.getItem("loopback.token")).toBe(TOKEN);

		await user.click(await screen.findByRole("button", { name: "Account" }));
		await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
		expect(await screen.findByLabelText("Token")).toBeInTheDocument();
		expect(localStorage.getItem("loopback.token")).toBeNull();
	});

	it("asks for the token again when the one it holds is refused", async () => {
		serving({ vouched: false });
		open("/", "a-token-that-was-rotated-away-since-then");
		expect(await screen.findByLabelText("Token")).toBeInTheDocument();
	});

	it("follows a link from before links had paths to its ask", async () => {
		serving({ vouched: false });
		open("/#/ask-1", TOKEN);
		await waitFor(() => expect(here()).toBe("/w/default/asks/ask-1"));
	});
});
