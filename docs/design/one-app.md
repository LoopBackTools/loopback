# One inbox app for every deployment

**Status:** built: `@loopbacktools/app`, with `apps/loopback` composed on it. Hosts move onto it next.

The inbox components are already one package, `@loopbacktools/inbox`, and every deployment renders the
same asks. What isn't shared is the app around them: the header, the connection status, the
notifications toggle, routing, the page that explains how to connect an agent, and soon the reload
when a deploy changes the contract ([versioned messages](versioned-messages.md)). Each deployment
writes its own. This proposes one app that every deployment composes, as the server already is.

## Why

- **The server already works this way.** The server's factory (since replaced by the core and an
  edge per deployment) is the whole server, and a deployment supplies only what differs: who may
  call it, and how. A host that signs
  people in its own way composes the same server with its own gate in a few dozen lines.
- **The front end doesn't.** `apps/loopback` has its own shell (about 280 lines), and a host with
  its own sign-in writes another. Every change to the shell is made once per deployment, and they
  drift apart.
- **Versioning needs it.** The reload when a tab falls behind the server, and drawing what can't be
  read, should be built once and reach every deployment.

## The pattern

Ports and adapters, on the front end. The open-source package defines the app and the few things it
needs from a deployment, as interfaces. Each deployment is a short entry file that fills them in, its
composition root.

```ts
createLoopbackApp({
	session, // who is signed in, how they sign in, and how they sign out
	workspaces, // which workspaces they can open, and a client for each
	extensions, // optional: the deployment's own pages and menu items
});
```

### `session`

- Who is signed in, as the app shows them, while it's loading, or nobody.
- The sign-in page, as a component the app shows when nobody is signed in. It returns the person to
  where they were going: a path in the app, or a page of the server's the deployment names
  (`continueAt`), as an OAuth authorization an agent started is, loaded in full.
- Signing out, when there is something to sign out of.

### `workspaces`

- The workspaces the person can open, each an id and a name. Each is a Loopback space; the
  server's `spaces` option already serves several.
- A client for one workspace: an SDK client whose token is minted for it. A hook, `useClient`,
  since a deployment may hold its client in its own state, as the self-host does.
- Optionally, making a new one.

The switcher appears only when there's more than one workspace, or a way to make one.

### `extensions`

- Pages of the deployment's own, each a path, a component, and whether it needs someone signed in.
  They stand alone, without the inbox's header, as every page a host has today does; `Page` and
  `Section` give them the app's look. They render inside the app, so they share its providers.
- Items for the workspace menu and the account menu.
- Banners above the inbox.

The app's own pages are the inbox (`/w/:workspace` and `/w/:workspace/asks/:id`) and connecting an
agent (`/w/:workspace/connect`). How agents sign in, with OAuth or a token, is not a setting: the
SDK asks the server, which serves the MCP endpoint's protected resource metadata only for OAuth.

## What each deployment supplies

**Self-host** (`apps/loopback`), about the same code it has today, moved behind the interfaces:

- `session`: the token pasted on the sign-in page, or nothing to do when a Worker in front vouches
  for its callers;
- `workspaces`: the one space the token opens;
- no extensions.

**A host with accounts** supplies its own sign-in, its people's workspaces, and its own pages
(accounts, members, invitations, an OAuth consent screen) as extensions. Nothing of a host's own
comes into the open-source repo: the repo defines the interfaces, and the host fills them in.

## Package

A new package, `@loopbacktools/app`, built on `@loopbacktools/inbox`. The inbox stays a set of components
for a deployment that wants to put them inside an app of its own; the app is for one that wants the
whole thing.

An architecture test keeps the split honest: `@loopbacktools/app` and `@loopbacktools/inbox` import no
sign-in library and nothing about accounts, only the SDK and the interfaces.

## Routing

The app routes by path, for every deployment. Assets already fall back to the app for any path that
isn't the API, MCP or discovery. Links to an ask become `/w/<workspace>/asks/<id>`, which is the
server's `inboxUrl` default too. A link in the old form, `/#/<id>`, is still followed, to the ask in
the only workspace, so links already in agents' transcripts keep working.

## Order of work

Alongside the versioning work, released with it in 0.4.0, the first npm release:

1. `@loopbacktools/app` with the interfaces, the shell moved out of `apps/loopback`, path routing,
   and the old links followed. Tested with fake adapters. Done.
2. `apps/loopback` becomes its entry file and its token adapters. Done.
3. The reload signal and "can't be shown" built into the app, when versioning's steps 3 to 5 land.
   Done: both live in the inbox, so every deployment has them through the app.
4. Hosts move onto it.

## Settled while building

- The theme follows the system (`followSystemTheme`), and the favicon is the deployment's own
  `/favicon.svg`. Brand beyond that waits for a deployment that needs it.
- An extension page shares the app's providers by rendering inside the app.
- The deployment keeps the `RegistryProvider` in its own entry, as the inbox already asks, so it
  can seed atoms of its own.
