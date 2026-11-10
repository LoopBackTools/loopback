import { Cause, ConfigProvider, Effect, Exit, Layer, Logger, ManagedRuntime } from "effect";
import type { EdgeBindings } from "./env.ts";
import { ConfiguredGate, type Gate } from "./gate.ts";
import { NotConfigured, problem } from "./problems.ts";

export type EdgeRuntime = ManagedRuntime.ManagedRuntime<Gate, never>;

/**
 * One runtime per environment, holding the gate the deployment's settings choose. Settings are read
 * from the environment, and logs are JSON, which Workers Logs indexes.
 */
const runtimes = new WeakMap<object, EdgeRuntime>();
export const runtimeOf = (env: EdgeBindings): EdgeRuntime => {
	let runtime = runtimes.get(env);
	if (runtime === undefined) {
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				ConfiguredGate,
				ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
				Logger.layer([Logger.consoleJson]),
			),
		);
		runtimes.set(env, runtime);
	}
	return runtime;
};

/**
 * A request that died rather than failing with a declared error: the deployment is not configured,
 * the request was abandoned, or something is broken. Thrown past the handler to `answerUnhandled`.
 */
export class Unhandled extends Error {
	override readonly name = "Unhandled";
	readonly defect: unknown;
	readonly interrupted: boolean;
	constructor(cause: Cause.Cause<unknown>) {
		const defect = Cause.squash(cause);
		super(defect instanceof Error ? defect.message : String(defect));
		this.defect = defect;
		this.interrupted = Cause.hasInterrupts(cause);
	}
}

/**
 * Runs an effect on the runtime. Its error channel is `never`: every declared error has already
 * become an answer. What remains dies: it is logged under the request's id, and thrown as
 * `Unhandled`. A request its client abandoned is only interrupted, and not logged.
 */
export const run = async <A>(
	runtime: EdgeRuntime,
	signal: AbortSignal,
	requestId: string,
	effect: Effect.Effect<A, never, Gate>,
): Promise<A> => {
	const exit = await runtime.runPromiseExit(
		effect.pipe(
			Effect.tapCause((cause) =>
				Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Request died", cause),
			),
			Effect.annotateLogs({ requestId }),
		),
		{ signal },
	);
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Unhandled(exit.cause);
};

/** The setting that is missing or wrong, when a failure is one. */
export const notConfigured = (error: unknown): NotConfigured | undefined => {
	const defect = error instanceof Unhandled ? error.defect : error;
	return defect instanceof NotConfigured ? defect : undefined;
};

/**
 * What the caller of a request that died is told: only its id. `run` has logged it already;
 * anything else that reached here died outside it, a call to the core among them, and is logged now.
 */
export const incident = (error: unknown, requestId: string): string => {
	if (!(error instanceof Unhandled)) {
		console.error(
			JSON.stringify({
				level: "ERROR",
				message: "Request died",
				requestId,
				cause:
					error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
			}),
		);
	}
	return `Something went wrong in Loopback. Incident ${requestId}.`;
};

/** What an unhandled request answers: a 500 naming a missing setting, or one with an incident id. */
export const answerUnhandled = (error: unknown, requestId: string): Response => {
	const missing = notConfigured(error);
	if (missing !== undefined) {
		return Response.json(problem("server.not_configured", missing.message), { status: 500 });
	}
	return Response.json(problem("server.defect", incident(error, requestId)), { status: 500 });
};
