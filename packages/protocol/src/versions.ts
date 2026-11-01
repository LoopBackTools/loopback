/**
 * How the parts of a deployment name the code they run, over HTTP. Every API response names the
 * revision of the contract its server writes, and the build of the deploy it is from. A client names
 * the revision it writes on every request; one naming a later revision than the server's, as a page
 * from newer code does after a rollback, is refused with `409` and the problem code `reload`. See
 * docs/design/versioned-messages.md.
 */
export const REVISION_HEADER = "Loopback-Revision";
export const BUILD_HEADER = "Loopback-Build";

/** The problem code a request from newer code than the server's is refused with: reload onto it. */
export const RELOAD_CODE = "reload";
