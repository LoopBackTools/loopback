import type { LoopbackApi } from "@loopbacktools/sdk";
import type { Icon } from "@phosphor-icons/react";
import type { ComponentType } from "react";

// What the app needs from the deployment it runs in, and nothing more: who is signed in, which
// workspaces they can open, and anything of the deployment's own. Each deployment fills these in,
// in a short entry file of its own. See docs/design/one-app.md.

/** Someone signed in, as the app shows them. */
export interface SignedIn {
	/** How to show them, such as their name or email address, when the deployment knows. */
	readonly name?: string;
	/** Signs them out, where there is something to sign out of. */
	readonly signOut?: () => void | Promise<void>;
}

export interface Session {
	/**
	 * Who is signed in: `undefined` while that is being found out, `null` when nobody is. A React
	 * hook, so the deployment can read its own session however it keeps it.
	 */
	readonly useSignedIn: () => SignedIn | null | undefined;
	/**
	 * The page for someone not signed in, at `/sign-in`. Once they are, the app sends them on to
	 * `next`, the path they were going to.
	 */
	readonly SignIn: ComponentType<{ readonly next: string }>;
	/**
	 * Where someone at the sign-in page goes once signed in, when it is a page of the server's
	 * rather than the app's, as an authorization an agent started is. The app loads it in full, in
	 * place of routing to `next`. Given the sign-in page's query; `undefined` for no such page.
	 */
	readonly continueAt?: (search: URLSearchParams) => string | undefined;
}

/** A workspace someone can open: one Loopback space. */
export interface WorkspaceSummary {
	readonly id: string;
	readonly name: string;
}

export interface Workspaces {
	/** The workspaces the person signed in can open: `undefined` while loading. A React hook. */
	readonly useList: () => readonly WorkspaceSummary[] | undefined;
	/** Which of them the app opens first: the one they used last, say. A React hook. */
	readonly usePreferred?: () => string | undefined;
	/**
	 * The client for one workspace, carrying a credential for it. A React hook, giving back the same
	 * client for as long as the workspace stays open.
	 */
	readonly useClient: (workspace: string) => LoopbackApi;
	/** Makes a new workspace: its id, or `undefined` when none was made. */
	readonly create?: () => Promise<string | undefined>;
}

/** An entry in one of the app's menus: somewhere to go, or something to do. */
export interface MenuItem {
	readonly label: string;
	readonly icon?: Icon;
	readonly to?: string;
	readonly onSelect?: () => void | Promise<void>;
}

/** A page of the deployment's own. It stands alone, without the inbox's header: see `Page`. */
export interface ExtensionPage {
	/** Where it is, as a route path: `/account`, or `/w/:workspace/settings`. */
	readonly path: string;
	readonly Page: ComponentType;
	/** Whether it is for someone signed in; anyone else is sent to sign in, and back. */
	readonly signedIn: boolean;
}

export interface Extensions {
	readonly pages?: readonly ExtensionPage[];
	/** Items for a workspace's menu, below the workspaces. */
	readonly workspaceMenu?: (workspace: string) => readonly MenuItem[];
	/** Items for the menu of the person signed in, above signing out. */
	readonly accountMenu?: readonly MenuItem[];
	/** Shown above a workspace's inbox. */
	readonly Banner?: ComponentType<{ readonly workspace: string }>;
}

export interface LoopbackAppOptions {
	readonly session: Session;
	readonly workspaces: Workspaces;
	readonly extensions?: Extensions;
}
