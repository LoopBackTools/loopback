import { RegistryProvider } from "@effect/atom-react";
import type { Ask, InboxState, LoopbackApi } from "@loopbacktools/sdk";
import { Person } from "@phosphor-icons/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLoopbackApp,
	type Extensions,
	type LoopbackAppOptions,
	type SignedIn,
	type WorkspaceSummary,
} from "../src/index.ts";
import { loadPage } from "../src/location.ts";

vi.mock("../src/location.ts", () => ({ loadPage: vi.fn<(url: string) => void>() }));

const ask = (id: string, question: string): Ask => ({
	kind: "question",
	prompt: { question, options: [{ label: "Yes" }, { label: "No" }], multiple: false },
	id,
	status: "awaiting_human",
	waiting: true,
	thread: [],
	createdAt: "2026-11-01T10:00:00.000Z",
	updatedAt: "2026-11-01T10:00:00.000Z",
});

/** A workspace's space as its client sees it: the asks it holds, live. */
const clientWith = (open: Ask[], agentSignIn: "oauth" | "token" = "oauth"): LoopbackApi => {
	const state: InboxState = { status: "live", open, recent: [] };
	return {
		whoami: Effect.succeed({ space: "acme", actor: { id: "ada" } }),
		snapshot: Effect.die("unused"),
		ask: () => Effect.die("unused"),
		history: () => Effect.die("unused"),
		reply: () => Effect.die("unused"),
		file: () => Effect.die("unused"),
		agentSignIn: Effect.succeed(agentSignIn),
		events: Stream.empty,
		inbox: Stream.make(state).pipe(Stream.concat(Stream.never)),
		update: Stream.make("none" as const).pipe(Stream.concat(Stream.never)),
	};
};

/** A value a test changes, read by the app through a hook, as a deployment's session store is. */
const held = <A,>(initial: A) => {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		set: (next: A) => {
			value = next;
			for (const listener of listeners) listener();
		},
		use: () =>
			useSyncExternalStore(
				(listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				() => value,
			),
	};
};

const ACME: WorkspaceSummary = { id: "acme", name: "Acme" };
const BETA: WorkspaceSummary = { id: "beta", name: "Beta" };

/** A deployment, with fakes for whatever a test leaves out. */
const deployment = ({
	signedIn = { name: "Ada" },
	workspaces = [ACME],
	preferred,
	create,
	agents = "oauth",
	extensions,
	continueAt,
}: {
	continueAt?: (search: URLSearchParams) => string | undefined;
	signedIn?: SignedIn | null;
	workspaces?: WorkspaceSummary[];
	preferred?: string;
	create?: () => Promise<string | undefined>;
	agents?: "oauth" | "token";
	extensions?: Extensions;
} = {}) => {
	const session = held<SignedIn | null | undefined>(signedIn);
	const clients = new Map<string, LoopbackApi>();
	const clientFor = vi.fn<(workspace: string) => LoopbackApi>((workspace) => {
		const client =
			clients.get(workspace) ??
			clientWith([ask(`${workspace}-1`, `A question in ${workspace}?`)], agents);
		clients.set(workspace, client);
		return client;
	});
	const options: LoopbackAppOptions = {
		session: {
			useSignedIn: session.use,
			SignIn: ({ next }) => (
				<button type="button" onClick={() => session.set({ name: "Ada" })}>
					Sign in, then go to {next}
				</button>
			),
			...(continueAt === undefined ? {} : { continueAt }),
		},
		workspaces: {
			useList: () => workspaces,
			...(preferred === undefined ? {} : { usePreferred: () => preferred }),
			useClient: clientFor,
			...(create === undefined ? {} : { create }),
		},
		...(extensions === undefined ? {} : { extensions }),
	};
	return { options, session, clientFor };
};

/** The app at `path`, as a browser opening that address. */
const open = (options: LoopbackAppOptions, path: string) => {
	window.history.replaceState(null, "", path);
	const App = createLoopbackApp(options);
	return render(
		<RegistryProvider>
			<App />
		</RegistryProvider>,
	);
};

const here = () => `${window.location.pathname}${window.location.hash}`;

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.mocked(loadPage).mockClear();
});

describe("the app", () => {
	it("sends someone not signed in to sign in, and on to where they were going", async () => {
		const user = userEvent.setup();
		open(deployment({ signedIn: null }).options, "/w/acme/asks/acme-1");
		await user.click(
			await screen.findByRole("button", { name: "Sign in, then go to /w/acme/asks/acme-1" }),
		);
		expect(await screen.findAllByText("A question in acme?")).not.toHaveLength(0);
		expect(here()).toBe("/w/acme/asks/acme-1");
	});

	it("sends someone signing in nowhere but this app", async () => {
		const user = userEvent.setup();
		open(deployment({ signedIn: null }).options, "/sign-in?next=//elsewhere.example/steal");
		await user.click(await screen.findByRole("button", { name: "Sign in, then go to /" }));
		await waitFor(() => expect(here()).toBe("/w/acme"));
	});

	it("loads the server's page a sign-in continues to, once signed in, and nowhere else", async () => {
		const user = userEvent.setup();
		const authorize = (search: URLSearchParams) =>
			search.has("client_id") ? `/api/auth/oauth2/authorize?${search}` : undefined;
		const { options } = deployment({ signedIn: null, continueAt: authorize });
		open(options, "/sign-in?client_id=agent&sig=signed");
		await user.click(await screen.findByRole("button", { name: /^Sign in/ }));
		await waitFor(() =>
			expect(loadPage).toHaveBeenCalledWith(
				"/api/auth/oauth2/authorize?client_id=agent&sig=signed",
			),
		);
		expect(loadPage).toHaveBeenCalledOnce();
		expect(here()).toBe("/sign-in");
	});

	it("loads it at once for someone already signed in", async () => {
		const authorize = (search: URLSearchParams) =>
			search.has("client_id") ? `/api/auth/oauth2/authorize?${search}` : undefined;
		open(deployment({ continueAt: authorize }).options, "/sign-in?client_id=agent&sig=signed");
		await waitFor(() => expect(loadPage).toHaveBeenCalledOnce());
		expect(here()).toBe("/sign-in");
	});

	it("opens the workspace the person prefers at the front door", async () => {
		const { options, clientFor } = deployment({ workspaces: [ACME, BETA], preferred: "beta" });
		open(options, "/");
		await waitFor(() => expect(here()).toBe("/w/beta"));
		expect(clientFor).toHaveBeenLastCalledWith("beta");
	});

	it("follows a link from before links had paths to its ask", async () => {
		open(deployment().options, "/#/acme-1");
		await waitFor(() => expect(here()).toBe("/w/acme/asks/acme-1"));
	});

	it("offers a new workspace to someone in none, where the deployment makes them", async () => {
		const user = userEvent.setup();
		const create = vi.fn<() => Promise<string | undefined>>(async () => "acme");
		const { options } = deployment({ workspaces: [], create });
		open(options, "/");
		await user.click(await screen.findByRole("button", { name: "New workspace" }));
		await waitFor(() => expect(here()).toBe("/w/acme"));
	});

	it("says so when a workspace isn't the person's", async () => {
		const { options, clientFor } = deployment();
		open(options, "/w/someone-else");
		expect(await screen.findByText("Not one of your workspaces")).toBeInTheDocument();
		expect(clientFor).not.toHaveBeenCalled();
	});
});

describe("the header", () => {
	it("switches workspace, with a client of the workspace's own", async () => {
		const user = userEvent.setup();
		const { options, clientFor } = deployment({ workspaces: [ACME, BETA] });
		open(options, "/w/acme");
		await user.click(await screen.findByRole("button", { name: "Acme" }));
		await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
		await waitFor(() => expect(here()).toBe("/w/beta"));
		expect(clientFor).toHaveBeenLastCalledWith("beta");
	});

	it("links to connecting an agent, followed in the app", async () => {
		const user = userEvent.setup();
		open(deployment().options, "/w/acme");
		const connect = await screen.findByRole("link", { name: "Connect an agent" });
		expect(connect).toHaveAttribute("href", "/w/acme/connect");
		expect(screen.queryByRole("button", { name: "Connect an agent" })).toBeNull();
		await user.click(connect);
		expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeInTheDocument();
		expect(here()).toBe("/w/acme/connect");
	});

	it("has no workspace menu when there's one workspace and no way to make another", async () => {
		open(deployment().options, "/w/acme");
		expect(await screen.findByText("Live")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Acme" })).toBeNull();
	});

	it("signs out with a button of its own when there is nothing else in the person's menu", async () => {
		const user = userEvent.setup();
		const { options, session } = deployment({ signedIn: null });
		const signOut = vi.fn<() => void>(() => session.set(null));
		session.set({ signOut });
		open(options, "/w/acme");
		await user.click(await screen.findByRole("button", { name: "Sign out" }));
		expect(signOut).toHaveBeenCalledOnce();
		expect(await screen.findByRole("button", { name: /^Sign in/ })).toBeInTheDocument();
	});

	it("offers no signing out where there is nothing to sign out of", async () => {
		open(deployment({ signedIn: {} }).options, "/w/acme");
		expect(await screen.findByText("Live")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});
});

describe("a deployment's own", () => {
	it("pages, menu items and banner sit in the app", async () => {
		const user = userEvent.setup();
		const extensions: Extensions = {
			pages: [{ path: "/account", Page: () => <h1>Your account</h1>, signedIn: true }],
			accountMenu: [{ label: "Your account", icon: Person, to: "/account" }],
			workspaceMenu: (workspace) => [{ label: "Members", to: `/w/${workspace}/members` }],
			Banner: ({ workspace }) => <p>Add a passkey to {workspace}</p>,
		};
		open(deployment({ extensions }).options, "/w/acme");
		expect(await screen.findByText("Add a passkey to acme")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Ada" }));
		await user.click(await screen.findByRole("menuitem", { name: "Your account" }));
		expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
		expect(here()).toBe("/account");
	});
});

describe("connecting an agent", () => {
	it("says to sign in with OAuth where the server says agents do", async () => {
		open(deployment({ agents: "oauth" }).options, "/w/acme/connect");
		expect(
			await screen.findByText(`claude mcp add --transport http loopback ${location.origin}/mcp`),
		).toBeInTheDocument();
	});

	it("says to send the token where the server says agents do", async () => {
		open(deployment({ agents: "token" }).options, "/w/acme/connect");
		expect(
			await screen.findByText(/--header "Authorization: Bearer \$LOOPBACK_TOKEN"/),
		).toBeInTheDocument();
	});
});
