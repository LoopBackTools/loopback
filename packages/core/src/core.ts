import type {
	BriefingAnswerInput,
	BriefingInput,
	FollowUpInput,
	ImageType,
	QuestionInput,
	ReviewInput,
} from "@loopbacktools/protocol";
import { REVISION } from "@loopbacktools/protocol/schema";
import { exports, WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer, Logger, ManagedRuntime } from "effect";
import * as agent from "./agent.ts";
import type { CoreBindings } from "./env.ts";
import { Files } from "./files.ts";
import * as inbox from "./inbox.ts";
import type { Caller, CoreRpc, InboxOperations, PollIntervals, Wait } from "./rpc.ts";
import type { Space } from "./space/object.ts";
import { buildOf } from "./space/rpc.ts";
import { Spaces } from "./spaces.ts";

type CoreServices = Spaces | Files;

type CoreRuntime = ManagedRuntime.ManagedRuntime<CoreServices, never>;

/**
 * The Worker's `Space` class, as the runtime binds every Durable Object class a Worker exports: no
 * binding names the Worker, so a core deployed under any name reaches its own.
 */
const namespace = (): DurableObjectNamespace<Space> =>
	(exports as unknown as { readonly Space: DurableObjectNamespace<Space> }).Space;

/**
 * One runtime per environment, built only from binding-backed layers, so nothing one call leaves
 * pending is waited on by another. Every space is called as this code, revision and build, so a
 * space on older code restarts onto it. Logs are JSON, which Workers Logs indexes.
 */
const runtimes = new WeakMap<object, CoreRuntime>();
const runtimeOf = (env: CoreBindings): CoreRuntime => {
	let runtime = runtimes.get(env);
	if (runtime === undefined) {
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Spaces.layer(namespace(), { revision: REVISION, build: buildOf(env) }),
				Files.layer(env.FILES),
				Logger.layer([Logger.consoleJson]),
			),
		);
		runtimes.set(env, runtime);
	}
	return runtime;
};

/**
 * Runs a call. Its error channel is `never`: every declared error is already an answer. What remains
 * died, is logged here, where it happened, and fails the call.
 */
const run = async <A>(
	env: CoreBindings,
	effect: Effect.Effect<A, never, CoreServices>,
): Promise<A> => {
	const exit = await runtimeOf(env).runPromiseExit(
		effect.pipe(
			Effect.tapCause((cause) =>
				Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Call died", cause),
			),
		),
	);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
};

/**
 * The core: every space, its asks and its files, served to edges over RPC and to nothing else. It
 * has no public address, so it trusts its callers to have established who is calling.
 */
export class Core extends WorkerEntrypoint<CoreBindings> implements CoreRpc {
	Session_whoami(caller: Caller, _input: Record<string, never>) {
		return run(this.env, inbox.whoami(caller));
	}

	EventTickets_issue(caller: Caller, _input: Record<string, never>) {
		return run(this.env, inbox.issueTicket(caller));
	}

	Snapshots_read(caller: Caller, _input: Record<string, never>) {
		return run(this.env, inbox.snapshot(caller));
	}

	Asks_list(caller: Caller, input: Parameters<InboxOperations["Asks_list"]>[1]) {
		return run(this.env, inbox.history(caller, input.before, input.limit));
	}

	Asks_read(caller: Caller, input: Parameters<InboxOperations["Asks_read"]>[1]) {
		return run(this.env, inbox.read(caller, input.id));
	}

	Asks_reply(caller: Caller, input: Parameters<InboxOperations["Asks_reply"]>[1]) {
		return run(this.env, inbox.reply(caller, input.id, input.reply));
	}

	Files_read(caller: Caller, input: Parameters<InboxOperations["Files_read"]>[1]) {
		return run(this.env, inbox.readFile(caller, input.uploadId));
	}

	Uploads_store(_caller: Caller, input: Parameters<InboxOperations["Uploads_store"]>[1]) {
		return run(
			this.env,
			inbox.storeUpload({
				spaceId: input.spaceId,
				token: input.token,
				contentType: input["Content-Type"],
				length: input.length,
				body: input.body,
			}),
		);
	}

	askQuestion(caller: Caller, input: QuestionInput, client?: string, wait?: Wait) {
		return run(this.env, agent.askQuestion(caller, input, client, wait));
	}

	requestReview(caller: Caller, input: ReviewInput, client?: string, wait?: Wait) {
		return run(this.env, agent.requestReview(caller, input, client, wait));
	}

	sendBriefing(caller: Caller, input: BriefingInput, client?: string, wait?: Wait) {
		return run(this.env, agent.sendBriefing(caller, input, client, wait));
	}

	answerFollowUp(caller: Caller, input: FollowUpInput, wait?: Wait) {
		return run(this.env, agent.answerFollowUp(caller, input, wait));
	}

	answerBriefing(caller: Caller, input: BriefingAnswerInput, wait?: Wait) {
		return run(this.env, agent.answerBriefing(caller, input, wait));
	}

	followTask(caller: Caller, taskId: string, pollMs?: PollIntervals) {
		return run(this.env, agent.followTask(caller, taskId, pollMs));
	}

	cancelTask(caller: Caller, taskId: string, pollMs?: PollIntervals) {
		return run(this.env, agent.cancelTask(caller, taskId, pollMs));
	}

	createUpload(caller: Caller, contentType: ImageType) {
		return run(this.env, agent.createUpload(caller, contentType));
	}

	override fetch(request: Request) {
		return run(this.env, inbox.connect(request));
	}

	erase(space: string) {
		return run(this.env, inbox.erase(space));
	}

	async revision() {
		return REVISION;
	}
}
