/**
 * What a gate's settings must be: `LOOPBACK_TOKENS`, a JSON object from each person's id to their
 * token, or the JWT settings, never both. Read by the gate on every isolate, and by the deploy before
 * it deploys anything, so both refuse with the same words, which name a person and never a token.
 */

/** The shortest token accepted: long enough that guessing it is hopeless. */
export const MIN_TOKEN_LENGTH = 32;

const MAKE_ONE = "Generate one with `openssl rand -hex 32`.";

/** What an edge with no tokens is told. */
export const NO_TOKENS =
	'LOOPBACK_TOKENS is not set. Deploy with it in a secrets file (`cf deploy --secrets-file <file>`), as {"owner": "<token>"} with a token from `openssl rand -hex 32`, or set LOOPBACK_JWKS_URL and the other JWT settings for a space per tenant.';

/** What an edge with only the one token of 0.7 is told. */
export const OLD_TOKEN =
	'LOOPBACK_TOKEN is replaced by LOOPBACK_TOKENS: put your token in it as {"owner": "<token>"} and deploy again.';

/** What an edge with both gates' settings is told. */
export const BOTH_GATES =
	"Both LOOPBACK_TOKENS and LOOPBACK_JWKS_URL are set. Set one: tokens for a single space, or the JWT settings for a space per tenant.";

/** The settings a JWT-gated edge can't do without, beside `LOOPBACK_JWKS_URL`. */
export const JWT_REQUIRED = [
	"LOOPBACK_JWKS_URL",
	"LOOPBACK_JWT_ISSUER",
	"LOOPBACK_JWT_AUDIENCE",
	"LOOPBACK_SPACE_CLAIM",
] as const;

/** What a JWT-gated edge missing one of them is told. */
export const missingJwtSetting = (name: string) =>
	`${name} is not set; a JWT-gated deployment needs it.`;

/** The people a map lets in, each with their token, or why the map can't be trusted. */
export type Tokens =
	| { readonly people: ReadonlyArray<{ readonly id: string; readonly token: string }> }
	| { readonly problem: string };

/**
 * The people `LOOPBACK_TOKENS` names. A map that can't be trusted is refused outright: one that isn't
 * a JSON object or is empty, a person with no name, and a token that is short, one character
 * repeated, or another person's too.
 */
export const readTokens = (setting: string): Tokens => {
	const notAMap = `LOOPBACK_TOKENS must be a JSON object from each person to their token, such as {"owner": "<token>"}. ${MAKE_ONE}`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(setting);
	} catch {
		return { problem: notAMap };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { problem: notAMap };
	}
	const entries = Object.entries(parsed);
	if (entries.length === 0) {
		return {
			problem: `LOOPBACK_TOKENS has no one in it: put each person's token in it, as {"owner": "<token>"}. ${MAKE_ONE}`,
		};
	}
	const holders = new Map<string, string>();
	const people: { readonly id: string; readonly token: string }[] = [];
	for (const [id, token] of entries) {
		// A name as long as a token is most likely one, the map written the wrong way round: it is
		// refused without being repeated, since every other refusal names the person.
		if (id.length >= MIN_TOKEN_LENGTH) {
			return {
				problem: `LOOPBACK_TOKENS names someone with ${id.length} characters, as long as a token: put each person's name first, as {"owner": "<token>"}.`,
			};
		}
		if (id.trim() === "") {
			return {
				problem:
					'LOOPBACK_TOKENS has a person with no name: give each person a name, as in {"owner": "<token>"}.',
			};
		}
		if (typeof token !== "string") {
			return { problem: `The token for "${id}" in LOOPBACK_TOKENS must be a string. ${MAKE_ONE}` };
		}
		if (token.length < MIN_TOKEN_LENGTH) {
			return {
				problem: `The token for "${id}" in LOOPBACK_TOKENS is shorter than ${MIN_TOKEN_LENGTH} characters. ${MAKE_ONE}`,
			};
		}
		if (new Set(token).size === 1) {
			return {
				problem: `The token for "${id}" in LOOPBACK_TOKENS is one character repeated, which anyone could guess. ${MAKE_ONE}`,
			};
		}
		const holder = holders.get(token);
		if (holder !== undefined) {
			return {
				problem: `"${holder}" and "${id}" have the same token in LOOPBACK_TOKENS: give each person their own. ${MAKE_ONE}`,
			};
		}
		holders.set(token, id);
		people.push({ id, token });
	}
	return { people };
};
