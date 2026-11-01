/** Where a workspace's inbox, or one ask in it, is in the app. */
export const workspacePath = (workspace: string, askId?: string): string =>
	`/w/${encodeURIComponent(workspace)}${askId === undefined ? "" : `/asks/${encodeURIComponent(askId)}`}`;

/** Where the page on connecting an agent to a workspace is. */
export const connectPath = (workspace: string): string => `${workspacePath(workspace)}/connect`;

/**
 * Where to send someone once they have signed in: a path in this app, never another site, so a link
 * to the sign-in page can't be made to send people elsewhere.
 */
export const safeNext = (next: string | null): string =>
	next !== null && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
		? next
		: "/";

/** The ask an old link names, from before links had paths: `/#/<id>`. */
export const askInOldLink = (hash: string): string | undefined => {
	const id = /^#\/(.+)$/.exec(hash)?.[1];
	return id === undefined ? undefined : decodeURIComponent(id);
};
