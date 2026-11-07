import type { Block } from "@loopbacktools/sdk";
import { Blocks, Prose } from "./content.tsx";
import { age } from "./hooks.ts";

const SAID = "text-[17px] text-kumo-default [--prose-leading:27px]";

/** A turn the agent took in a thread: its answer, and anything it showed with it. */
export function AgentSaid({
	answer,
	content,
	at,
	now,
}: {
	readonly answer: string;
	readonly content?: readonly Block[] | undefined;
	readonly at: string;
	readonly now: number;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-(--loopback-edge) bg-kumo-elevated px-[18px] py-4">
			<p className="text-[15px] leading-[22px] font-semibold text-kumo-default">
				The agent answered <span className="font-normal text-kumo-subtle">· {age(at, now)}</span>
			</p>
			<Prose text={answer} className={SAID} />
			{content === undefined ? null : <Blocks blocks={content} />}
		</div>
	);
}

/** A turn the person took in a thread: what they did, and their words when they gave any. */
export function PersonSaid({
	title,
	body,
	at,
	now,
}: {
	readonly title: string;
	readonly body?: string | undefined;
	readonly at: string;
	readonly now: number;
}) {
	return (
		<div className="ml-auto flex max-w-[85%] flex-col gap-1.5 rounded-lg bg-kumo-tint px-[18px] py-4">
			<p className="text-[15px] leading-[22px] font-semibold text-kumo-default">
				{title} <span className="font-normal text-kumo-subtle">· {age(at, now)}</span>
			</p>
			{body === undefined ? null : <Prose text={body} className={SAID} />}
		</div>
	);
}
