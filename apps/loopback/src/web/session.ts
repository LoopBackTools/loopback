import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Session, Workspaces } from "@loopbacktools/app";
import { make, type LoopbackApi } from "@loopbacktools/sdk";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { SignIn } from "./sign-in.tsx";

const TOKEN_KEY = "loopback.token";

const readToken = (): string | null => {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
};

/** Remembers the token in this browser, or forgets it. */
const storeToken = (token: string | null) => {
	try {
		if (token === null) localStorage.removeItem(TOKEN_KEY);
		else localStorage.setItem(TOKEN_KEY, token);
	} catch {
		// Storage can be unavailable (a private window); the token then lasts for this tab only.
	}
};

/**
 * The token this inbox connects with, if it has one. Setting it remembers it in this browser, so the
 * two never disagree. Kept for the whole session, read or not.
 */
export const tokenAtom = Atom.keepAlive(
	Atom.writable(
		(): string | null => readToken(),
		(ctx, token: string | null) => {
			storeToken(token);
			ctx.setSelf(token);
		},
	),
);

/** A client with the token, or with none, for a page whose host already signs its requests in. */
const clientFor = (token: string | null): LoopbackApi =>
	make({ baseUrl: location.origin, ...(token === null ? {} : { token }) });

/**
 * What signs this page in, and the space it opens: the token it holds, or else its host, as a Worker
 * vouching for its callers does. `null` when neither is accepted.
 */
export const sessionAtom = Atom.make((get) => {
	const token = get(tokenAtom);
	const client = clientFor(token);
	return client.whoami.pipe(
		Effect.map((whoami) => ({ token, client, space: whoami.space })),
		Effect.catch(() => Effect.succeed(null)),
	);
});

/** Checks a token before keeping it: the space it opens, or why it was refused. */
export const signInAtom = Atom.fn((token: string) =>
	Effect.map(clientFor(token).whoami, (whoami) => ({ token, space: whoami.space })),
);

/** The page's session: `undefined` until it is known, `null` when nothing signs the page in. */
const useCurrent = () => {
	const current = useAtomValue(sessionAtom);
	return AsyncResult.isSuccess(current) ? current.value : undefined;
};

/** Signed in with the token pasted on the sign-in page, or by the page's host. */
export const session: Session = {
	useSignedIn: () => {
		const current = useCurrent();
		const setToken = useAtomSet(tokenAtom);
		if (current == null) return current;
		// A page its host signs in has nothing here to sign out of.
		return current.token === null ? {} : { signOut: () => setToken(null) };
	},
	SignIn,
};

/** The one space the page's credential opens. */
export const workspaces: Workspaces = {
	useList: () => {
		const current = useCurrent();
		return current == null ? undefined : [{ id: current.space, name: "Inbox" }];
	},
	useClient: () => {
		const current = useCurrent();
		if (current == null) throw new Error("The inbox opened before the page was signed in.");
		return current.client;
	},
};
