/** Loads a page in full, as one of the server's own pages needs, rather than routing to it. */
export const loadPage = (url: string): void => window.location.assign(url);
