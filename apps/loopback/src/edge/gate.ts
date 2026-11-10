import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import { NotConfigured } from "./problems.ts";
import { BOTH_GATES, missingJwtSetting, NO_TOKENS, OLD_TOKEN, readTokens } from "./tokens.ts";

/** Who a request is from, and which space it opens: the caller the core is told about. */
export interface Access {
	readonly space: string;
	readonly actor: { readonly id: string; readonly name?: string };
}

/** A request the gate turned away, with the reason its caller is told. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly reason: string }> {}

/**
 * Decides who a request is from. The token gate below serves one space to the people its settings
 * name; the JWT gate serves a space per tenant behind any login that issues JWTs.
 */
export class Gate extends Context.Service<
	Gate,
	{
		readonly authenticate: (request: Request) => Effect.Effect<Access, Unauthorized>;
		/**
		 * The OAuth authorization servers that issue the credentials this gate accepts, which MCP clients
		 * discover through protected resource metadata (RFC 9728). None when the gate has none.
		 */
		readonly authorizationServers: Effect.Effect<ReadonlyArray<string>>;
	}
>()("loopback/Gate") {}

/**
 * The bearer token a request presents. Only ever a header: Cloudflare redacts `Authorization` from
 * its logs, while a token sent any other way (a WebSocket subprotocol, say) would be logged in full.
 * Browsers open the event socket with a one-time ticket instead.
 */
export const credentialOf = (request: Request): string | undefined =>
	/^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];

const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

/** The space a token-gated deployment serves. */
export const DEFAULT_SPACE = "default";

/** Someone a deployment's tokens let in, with their token's digest. */
interface Person {
	readonly id: string;
	readonly digest: ArrayBuffer;
}

const refuse = (message: string) => Effect.die(new NotConfigured(message));

/** The people `LOOPBACK_TOKENS` lets in, digested, or the deployment refused for a map it can't trust. */
const peopleIn = (setting: string): Effect.Effect<ReadonlyArray<Person>> => {
	const tokens = readTokens(setting);
	if ("problem" in tokens) return refuse(tokens.problem);
	return Effect.promise(() =>
		Promise.all(tokens.people.map(async ({ id, token }) => ({ id, digest: await digest(token) }))),
	);
};

const setting = (name: string) =>
	Config.option(Config.NonEmptyString(name)).pipe(
		Effect.catch(() => Effect.succeed(Option.none<string>())),
	);

/**
 * `LOOPBACK_TOKENS` opens the deployment's one space to each person it names, as that person: a
 * friend given a token of their own is someone else in the same inbox. A presented token is digested
 * and compared in constant time with every person's, all of them every time, so neither whose it is
 * nor how many there are leaks through timing. The setting is read, as a redacted value no log can
 * show, and checked once per isolate on first use.
 */
export const makeTokensGate: Effect.Effect<Gate["Service"]> = Effect.gen(function* () {
	const people = yield* Effect.cached(
		Effect.gen(function* () {
			const tokens = yield* Config.option(Config.Redacted("LOOPBACK_TOKENS")).pipe(
				Effect.catch(() => Effect.succeed(Option.none<Redacted.Redacted>())),
			);
			if (Option.isNone(tokens)) {
				if (Option.isSome(yield* setting("LOOPBACK_TOKEN"))) return yield* refuse(OLD_TOKEN);
				return yield* refuse(NO_TOKENS);
			}
			return yield* peopleIn(Redacted.value(tokens.value));
		}),
	);
	return Gate.of({
		authenticate: (request) =>
			Effect.gen(function* () {
				const everyone = yield* people;
				const presented = credentialOf(request);
				if (presented === undefined) {
					return yield* new Unauthorized({ reason: "A bearer token is required." });
				}
				const actual = yield* Effect.promise(() => digest(presented));
				// Every person's digest is compared, the match included: `find` would stop at the match, and
				// how long that takes would say whose token it is.
				// oxlint-disable-next-line unicorn/prefer-array-find
				const [person] = everyone.filter((candidate) =>
					crypto.subtle.timingSafeEqual(candidate.digest, actual),
				);
				if (person === undefined) {
					return yield* new Unauthorized({ reason: "The token is not valid." });
				}
				const access: Access = {
					space: DEFAULT_SPACE,
					actor: { id: person.id, name: person.id },
				};
				return access;
			}),
		authorizationServers: Effect.succeed([]),
	});
});

/** How a JWT gate checks a token, and how it reads the caller from the token's claims. */
export interface JwtGateOptions {
	/** Where the login publishes the keys it signs tokens with, as a JSON Web Key Set. */
	readonly jwksUrl: string;
	/** The `iss` every token must carry; MCP clients are sent here to sign in. */
	readonly issuer: string;
	/** The audiences a token may be for; it must carry at least one of them in `aud`. */
	readonly audience: ReadonlyArray<string>;
	/** The claim that names the space a token opens. A token without it opens nothing. */
	readonly spaceClaim: string;
	/** The claim that holds the caller's display name. `name` unless said otherwise. */
	readonly nameClaim?: string;
}

/** The caller a token's claims name, read from the configured claims. */
const caller = z.object({
	sub: z.string().min(1),
	space: z.string().min(1),
});

/** The caller's display name, when the token carries a usable one; it never decides access. */
const nameOf = (claim: unknown): string | undefined =>
	typeof claim === "string" && claim.trim() !== "" ? claim : undefined;

/** The signature algorithms a token may use. `none` and the HMAC family are never among them. */
const ALGORITHMS = ["EdDSA", "ES256", "RS256"];

/** Failures that say the token is wrong, as opposed to the login's keys being out of reach. */
const refusals = [
	errors.JWTClaimValidationFailed,
	errors.JWTInvalid,
	errors.JWSInvalid,
	errors.JWSSignatureVerificationFailed,
	errors.JOSEAlgNotAllowed,
	errors.JOSENotSupported,
	errors.JWKSNoMatchingKey,
	errors.JWKSMultipleMatchingKeys,
];

/**
 * A gate for a deployment that serves a space per tenant behind any login that issues JWTs: a token
 * signed by one of the login's keys, from its issuer, for one of the audiences, opens the space its
 * claim names, as the person its `sub` names. Keys are fetched from the key set and cached by the
 * isolate. A key set out of reach is not the caller's fault, so it fails the request as a defect
 * rather than refusing it.
 */
export const makeJwtGate = (options: JwtGateOptions): Gate["Service"] => {
	const keys = createRemoteJWKSet(new URL(options.jwksUrl));
	const nameClaim = options.nameClaim ?? "name";
	return Gate.of({
		authenticate: Effect.fnUntraced(function* (request: Request) {
			const presented = credentialOf(request);
			if (presented === undefined) {
				return yield* new Unauthorized({ reason: "A bearer token is required." });
			}
			const verified = yield* Effect.tryPromise({
				try: () =>
					jwtVerify(presented, keys, {
						issuer: options.issuer,
						audience: [...options.audience],
						algorithms: ALGORITHMS,
					}),
				catch: (error) => error,
			}).pipe(
				Effect.catch((error) => {
					if (error instanceof errors.JWTExpired) {
						return Effect.fail(new Unauthorized({ reason: "The token has expired." }));
					}
					if (refusals.some((refusal) => error instanceof refusal)) {
						return Effect.fail(new Unauthorized({ reason: "The token is not valid." }));
					}
					return Effect.die(error);
				}),
			);
			const parsed = caller.safeParse({
				sub: verified.payload.sub,
				space: verified.payload[options.spaceClaim],
			});
			if (!parsed.success) {
				return yield* new Unauthorized({
					reason: `The token must name a person in \`sub\` and a space in \`${options.spaceClaim}\`.`,
				});
			}
			const { sub, space } = parsed.data;
			const name = nameOf(verified.payload[nameClaim]);
			const access: Access = { space, actor: name === undefined ? { id: sub } : { id: sub, name } };
			return access;
		}),
		authorizationServers: Effect.succeed([options.issuer]),
	});
};

const required = (name: string) =>
	setting(name).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.die(new NotConfigured(missingJwtSetting(name))),
				onSome: Effect.succeed,
			}),
		),
	);

/** The JWT gate's options, from the deployment's settings. */
export const configuredJwtOptions = Effect.gen(function* () {
	const nameClaim = yield* setting("LOOPBACK_NAME_CLAIM");
	const options: JwtGateOptions = {
		jwksUrl: yield* required("LOOPBACK_JWKS_URL"),
		issuer: yield* required("LOOPBACK_JWT_ISSUER"),
		audience: (yield* required("LOOPBACK_JWT_AUDIENCE"))
			.split(",")
			.map((audience) => audience.trim())
			.filter((audience) => audience.length > 0),
		spaceClaim: yield* required("LOOPBACK_SPACE_CLAIM"),
		...(Option.isSome(nameClaim) ? { nameClaim: nameClaim.value } : {}),
	};
	return options;
});

/**
 * The gate a deployment's settings choose: the token gate unless `LOOPBACK_JWKS_URL` is set, and the
 * JWT gate when it is. Both is a deployment that can't say who anyone is, answered as a 500 that says
 * so. Settings are read on first use.
 */
export const ConfiguredGate = Layer.effect(
	Gate,
	Effect.gen(function* () {
		const chosen = yield* Effect.cached(
			Effect.gen(function* () {
				const tokens = yield* setting("LOOPBACK_TOKENS");
				const jwks = yield* setting("LOOPBACK_JWKS_URL");
				if (Option.isSome(tokens) && Option.isSome(jwks)) {
					return yield* refuse(BOTH_GATES);
				}
				if (Option.isSome(jwks)) return makeJwtGate(yield* configuredJwtOptions);
				return yield* makeTokensGate;
			}),
		);
		return Gate.of({
			authenticate: (request) => Effect.flatMap(chosen, (gate) => gate.authenticate(request)),
			authorizationServers: Effect.flatMap(chosen, (gate) => gate.authorizationServers),
		});
	}),
);
