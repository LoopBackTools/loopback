import {
	Button,
	Empty,
	type LinkComponentProps,
	LinkButton,
	LinkProvider,
	Loader,
} from "@cloudflare/kumo";
import { useAtomValue } from "@effect/atom-react";
import { Inbox, InboxProvider } from "@loopbacktools/inbox";
import type { LoopbackApi } from "@loopbacktools/sdk";
import { Plus, Tray } from "@phosphor-icons/react";
import { AsyncResult, Atom } from "effect/reactivity";
import {
	type ComponentType,
	createContext,
	forwardRef,
	type ReactNode,
	use,
	useCallback,
	useEffect,
} from "react";
import {
	BrowserRouter,
	Link,
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
	useParams,
	useSearchParams,
} from "react-router";
import { Header } from "./header.tsx";
import { loadPage } from "./location.ts";
import { CopyBox, Page, Section } from "./page.tsx";
import { askInOldLink, safeNext, workspacePath } from "./paths.ts";
import type { LoopbackAppOptions, SignedIn as Signed } from "./ports.ts";

function Waiting() {
	return (
		<main className="flex h-full items-center justify-center">
			<Loader />
		</main>
	);
}

/** Kumo's links, followed by the app's router rather than by loading the page again. */
const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, ...rest }, ref) => <Link ref={ref} to={href ?? to ?? ""} {...rest} />,
);

const SignedInContext = createContext<Signed | null>(null);

/** Who is signed in, for a page behind `SignedIn`. */
const useSignedInHere = (): Signed => {
	const signedIn = use(SignedInContext);
	if (signedIn === null) throw new Error("Only a page for someone signed in knows who they are.");
	return signedIn;
};

/** A workspace that isn't the person's: they may have been removed, or the link is wrong. */
function NotTheirs() {
	return (
		<main className="flex h-full items-center justify-center p-4">
			<Empty
				icon={<Tray size={32} />}
				title="Not one of your workspaces"
				description="You may have been removed from it, or the link is wrong."
				contents={
					<LinkButton href="/" variant="secondary">
						Go to your inbox
					</LinkButton>
				}
			/>
		</main>
	);
}

/** Installs the Claude Code plugin, which holds only hooks: one command for every deployment. */
const PLUGIN_INSTALL = "claude plugin install loopback --marketplace LoopBackTools/loopback";

/** How agents sign in to a client's deployment, as its server says. */
const agentSignInAtom = Atom.family((client: LoopbackApi) => Atom.make(client.agentSignIn));

/** A line of help under something to copy. */
function Hint({ children }: { readonly children: ReactNode }) {
	return (
		<p className="text-[15px] leading-[22px] text-kumo-subtle md:text-[16px] md:leading-6">
			{children}
		</p>
	);
}

/** How to connect an agent to a workspace, as the server says its agents sign in. */
function Connect({
	workspace,
	client,
}: {
	readonly workspace: string;
	readonly client: LoopbackApi;
}) {
	const signIn = useAtomValue(agentSignInAtom(client));
	if (AsyncResult.isInitial(signIn)) return <Waiting />;
	const { origin } = window.location;
	const mcp = `${origin}/mcp`;
	const oauth = AsyncResult.isSuccess(signIn) && signIn.value === "oauth";
	return (
		<Page
			back={{ to: workspacePath(workspace), label: "Back to the inbox" }}
			title="Connect an agent"
			description={
				oauth
					? "Agents connect to Loopback over MCP and sign in as you. When one connects, you pick the workspace it asks in."
					: "Agents connect to Loopback over MCP, sending this deployment's token."
			}
		>
			<Section title="Claude Code">
				<CopyBox
					command
					text={
						oauth
							? `claude mcp add --scope user --transport http loopback ${mcp}`
							: `claude mcp add --scope user --transport http loopback ${mcp} --header "Authorization: Bearer $LOOPBACK_TOKEN"`
					}
				/>
				<Hint>
					{oauth
						? "Then run /mcp in Claude Code and sign in when it asks."
						: "With the token in LOOPBACK_TOKEN, in the shell you run it from."}
				</Hint>
				<CopyBox command text={PLUGIN_INSTALL} />
				<Hint>
					Then install the plugin, so every question comes here without your having to ask for it.
					It needs nothing else.
				</Hint>
			</Section>
			<Section title="Or have your agent do it">
				<CopyBox text={`Connect yourself to Loopback as ${origin}/llms.txt says.`} />
				<Hint>
					{oauth
						? "Paste this to your agent. It sets up what it can, and tells you when to sign in."
						: "Paste this to your agent. It sets up what it can, and asks you for the token."}
				</Hint>
			</Section>
			<Section title="Any other MCP client">
				<CopyBox text={mcp} />
				<Hint>
					{oauth
						? "Add it as a remote server over streamable HTTP. It signs in with OAuth."
						: "Add it as a remote server over streamable HTTP, with the header Authorization: Bearer and the token."}
				</Hint>
			</Section>
		</Page>
	);
}

const noPreference = (): string | undefined => undefined;

/**
 * The Loopback app, for a deployment to render: its inbox, a page on connecting agents, and the
 * deployment's own pages, routed by path. Render it inside a `RegistryProvider`, as the inbox needs.
 * The deployment's hooks are bound here, once: the app's pages call the same ones on every render.
 */
export const createLoopbackApp = (options: LoopbackAppOptions): ComponentType => {
	const { SignIn, continueAt } = options.session;
	const useSignedIn = options.session.useSignedIn;
	const useList = options.workspaces.useList;
	const usePreferred = options.workspaces.usePreferred ?? noPreference;
	const useClient = options.workspaces.useClient;
	const { create } = options.workspaces;
	const { pages = [], workspaceMenu, accountMenu = [], Banner } = options.extensions ?? {};

	/** A page for someone signed in; anyone else is sent to sign in, and brought back after. */
	function SignedIn({ children }: { readonly children: ReactNode }) {
		const signedIn = useSignedIn();
		const location = useLocation();
		if (signedIn === undefined) return <Waiting />;
		if (signedIn === null) {
			const next = `${location.pathname}${location.search}${location.hash}`;
			return <Navigate to={`/sign-in?next=${encodeURIComponent(next)}`} replace />;
		}
		return <SignedInContext value={signedIn}>{children}</SignedInContext>;
	}

	/**
	 * The deployment's sign-in page, until the person is signed in; then where they were going: a
	 * page of the server's the deployment names, loaded in full, or else `next`.
	 */
	function SignInPage() {
		const signedIn = useSignedIn();
		const [search] = useSearchParams();
		const next = safeNext(search.get("next"));
		const onward = signedIn == null ? undefined : continueAt?.(search);
		useEffect(() => {
			if (onward !== undefined) loadPage(onward);
		}, [onward]);
		if (signedIn === undefined || onward !== undefined) return <Waiting />;
		if (signedIn !== null) return <Navigate to={next} replace />;
		return <SignIn next={next} />;
	}

	/**
	 * The app's front door: the workspace the person prefers, or their first, and the ask an old link
	 * names in it. Someone in no workspace is offered a new one, where the deployment makes them.
	 */
	function Home() {
		const navigate = useNavigate();
		const location = useLocation();
		const list = useList();
		const preferred = usePreferred();
		if (list === undefined) return <Waiting />;
		const workspace = list.find((candidate) => candidate.id === preferred)?.id ?? list[0]?.id;
		if (workspace !== undefined) {
			return <Navigate to={workspacePath(workspace, askInOldLink(location.hash))} replace />;
		}
		return (
			<main className="flex h-full items-center justify-center p-4">
				<Empty
					icon={<Tray size={32} />}
					title="You're not in a workspace"
					description={
						create === undefined
							? "Ask someone to invite you to theirs."
							: "Make one to connect your agents to, or ask someone to invite you to theirs."
					}
					contents={
						create === undefined ? undefined : (
							<Button
								variant="primary"
								icon={<Plus />}
								onClick={() =>
									void create().then(async (id) => {
										if (id !== undefined) await navigate(workspacePath(id));
									})
								}
							>
								New workspace
							</Button>
						)
					}
				/>
			</main>
		);
	}

	/**
	 * One workspace's inbox, live, through the client the deployment gives for it. Another workspace
	 * is another client, so switching reconnects to that one.
	 */
	function WorkspaceInbox({
		workspace,
		list,
	}: {
		readonly workspace: string;
		readonly list: readonly { readonly id: string; readonly name: string }[];
	}) {
		const signedIn = useSignedInHere();
		const client = useClient(workspace);
		const { askId } = useParams();
		const navigate = useNavigate();
		const onSelect = useCallback(
			(id: string | null) => void navigate(workspacePath(workspace, id ?? undefined)),
			[navigate, workspace],
		);
		const hrefFor = useCallback((id: string) => workspacePath(workspace, id), [workspace]);
		return (
			<InboxProvider client={client}>
				<div className="flex h-full flex-col">
					{Banner === undefined ? null : <Banner workspace={workspace} />}
					<Inbox
						selectedId={askId ?? null}
						onSelect={onSelect}
						hrefFor={hrefFor}
						header={
							<Header
								workspace={workspace}
								signedIn={signedIn}
								workspaces={list}
								workspaceItems={workspaceMenu?.(workspace) ?? []}
								accountItems={accountMenu}
								create={create}
							/>
						}
					/>
				</div>
			</InboxProvider>
		);
	}

	function ConnectPage({ workspace }: { readonly workspace: string }) {
		return <Connect workspace={workspace} client={useClient(workspace)} />;
	}

	/** A page of one of the person's workspaces, or a page saying it isn't one of theirs. */
	function Theirs({ page }: { readonly page: "inbox" | "connect" }) {
		const { workspace = "" } = useParams();
		const list = useList();
		if (list === undefined) return <Waiting />;
		if (!list.some((candidate) => candidate.id === workspace)) return <NotTheirs />;
		return page === "inbox" ? (
			<WorkspaceInbox workspace={workspace} list={list} />
		) : (
			<ConnectPage workspace={workspace} />
		);
	}

	return function LoopbackApp() {
		return (
			<BrowserRouter>
				<LinkProvider component={RouterLink}>
					<Routes>
						<Route path="/sign-in" element={<SignInPage />} />
						<Route
							path="/w/:workspace"
							element={
								<SignedIn>
									<Theirs page="inbox" />
								</SignedIn>
							}
						/>
						<Route
							path="/w/:workspace/asks/:askId"
							element={
								<SignedIn>
									<Theirs page="inbox" />
								</SignedIn>
							}
						/>
						<Route
							path="/w/:workspace/connect"
							element={
								<SignedIn>
									<Theirs page="connect" />
								</SignedIn>
							}
						/>
						{pages.map(({ path, Page: Shown, signedIn }) => (
							<Route
								key={path}
								path={path}
								element={
									signedIn ? (
										<SignedIn>
											<Shown />
										</SignedIn>
									) : (
										<Shown />
									)
								}
							/>
						))}
						<Route
							path="*"
							element={
								<SignedIn>
									<Home />
								</SignedIn>
							}
						/>
					</Routes>
				</LinkProvider>
			</BrowserRouter>
		);
	};
};
