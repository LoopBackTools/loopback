# @loopbacktools/app

The [Loopback](https://github.com/LoopBackTools/loopback) app: the inbox, routed by path, with its
header, the page on connecting an agent, and the reload when Loopback is updated under it. Every
Loopback deployment renders the same app and supplies only what differs: who is signed in, which
workspaces they can open, and any pages of its own. The deployment this repository ships,
`apps/loopback`, is one short entry file built on it.

```sh
pnpm add @loopbacktools/app @loopbacktools/inbox @loopbacktools/sdk @cloudflare/kumo @effect/atom-react effect react react-dom react-router
```

## Composing it

```tsx
import { RegistryProvider } from "@effect/atom-react";
import { createLoopbackApp, followSystemTheme } from "@loopbacktools/app";
import { make } from "@loopbacktools/sdk";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";

const App = createLoopbackApp({
	session: {
		// Who is signed in: undefined while loading, null for nobody.
		useSignedIn: () => {
			const user = useYourSession();
			return user === undefined ? undefined : user === null ? null : { name: user.email, signOut };
		},
		// Shown at /sign-in; once someone is signed in, the app sends them on to `next`.
		SignIn: ({ next }) => <YourSignIn returnTo={next} />,
		// Optional: a page of the server's that signing in continues to, loaded in full.
		continueAt: (search) =>
			search.has("client_id") ? `/api/auth/oauth2/authorize?${search}` : undefined,
	},
	workspaces: {
		useList: () => useYourWorkspaces(), // [{ id, name }], or undefined while loading
		useClient: (workspace) =>
			useMemo(
				() => make({ baseUrl: location.origin, token: () => tokenFor(workspace) }),
				[workspace],
			),
		create: async () => createYourWorkspace(), // optional: the new one's id
	},
	extensions: {
		pages: [{ path: "/account", Page: Account, signedIn: true }],
		accountMenu: [{ label: "Your account", to: "/account" }],
		workspaceMenu: (workspace) => [{ label: "Members", to: `/w/${workspace}/members` }],
		Banner: ({ workspace }) => <YourBanner workspace={workspace} />,
	},
});

followSystemTheme();
createRoot(document.getElementById("root")!).render(
	<RegistryProvider>
		<App />
	</RegistryProvider>,
);
```

Every port is a React hook or a component, so a deployment reads its session and workspaces however
it keeps them. The app imports no sign-in library; a test keeps it that way.

## What it serves

- `/w/:workspace` and `/w/:workspace/asks/:id`: a workspace's inbox, through the client
  `useClient` gives for it. The server's links to asks are of this form.
- `/w/:workspace/connect`: how to connect an agent. Whether agents sign in with OAuth or send a token
  comes from the server itself.
- `/sign-in`: the deployment's own sign-in page. Once someone is signed in, it sends them on to
  `next`, a path in the app, or to the page `continueAt` names, loaded in full: an OAuth
  authorization an agent started, say.
- `/`: the workspace the person prefers (`usePreferred`), or their first. An old link, `/#/<id>`, is
  followed to that ask.
- The deployment's pages. They stand alone, without the inbox's header; `Page` and `Section` give
  them the app's look.

The workspace menu appears where there is more than one workspace, a way to make one, or items of the
deployment's own. With no account items and no name to show, signing out is a button of its own, and
with nothing to sign out of, there is none.

## Styling

Beside the inbox's, in your stylesheet:

```css
@import "@loopbacktools/inbox/styles.css";
@import "@loopbacktools/app/styles.css";
```

## Stability

Until 1.0, a minor release may change this package's API. Pin the minor version you build on.

MIT licensed.
