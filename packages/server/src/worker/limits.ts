import { Context, Effect, Layer } from "effect";
import { RateLimited } from "../domain/errors.ts";
import { type LoopbackBindings, type WorkerBindings, WorkerEnv } from "./env.ts";
import type { Access } from "./gate.ts";

/**
 * Whether a request may go on to its space, asked once its caller is known. This is where a
 * deployment limits its tenants: `rateLimit` below counts each space's requests with a Cloudflare
 * Rate Limiting binding, and any other limit is another layer providing this service.
 */
export class Limits extends Context.Service<
	Limits,
	{ readonly admit: (access: Access) => Effect.Effect<void, RateLimited> }
>()("loopback/Limits") {
	/** No limits: every request goes on. */
	static readonly none = Layer.succeed(Limits, Limits.of({ admit: () => Effect.void }));
}

/** How `rateLimit` counts: the binding, and the seconds a refused caller is told to wait. */
export interface RateLimitOptions {
	/** A Rate Limiting binding. Its limit and period are declared with it, in the Worker's config. */
	readonly limiter: RateLimit;
	/** What `Retry-After` says: the binding's period, since it doesn't say when its count resets. */
	readonly retryAfter: number;
}

/**
 * Limits each space's requests with a Cloudflare Rate Limiting binding, keyed by the space. The
 * binding counts per location and approximately, which suits shedding a flood, not exact quotas. A
 * binding that fails lets the request through, logged: the limit protects the service, and must not
 * take it down. `options` may take the host's own environment type, as `jwtGate`'s does.
 */
// The parameter is what lets `options` take the host's own environment type, as jwtGate's does.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export const rateLimit = <Env extends LoopbackBindings = WorkerBindings>(
	options: (env: Env) => RateLimitOptions,
) =>
	Layer.effect(
		Limits,
		WorkerEnv.use((env) =>
			Effect.sync(() => {
				const { limiter, retryAfter } = options(env as unknown as Env);
				return Limits.of({
					admit: (access) =>
						Effect.tryPromise(() => limiter.limit({ key: access.space })).pipe(
							Effect.matchEffect({
								onFailure: (cause) =>
									Effect.logWarning("The rate limiter failed; the request goes on.", cause),
								onSuccess: ({ success }) =>
									success
										? Effect.void
										: Effect.fail(
												new RateLimited({
													reason: `Too many requests for this workspace. Try again in ${retryAfter} seconds.`,
													retryAfter,
												}),
											),
							}),
						),
				});
			}),
		),
	);
