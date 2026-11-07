import type { Ask, InboxState } from "@loopbacktools/sdk";
import {
	CaretDown,
	CaretRight,
	ChatCircleDots,
	Eye,
	ListBullets,
	Question,
} from "@phosphor-icons/react";
import { AskLink } from "./context.tsx";
import { age, headline, pointsNeedingYou, useNow, useRecentOpen } from "./hooks.ts";

export function KindIcon({ ask, size = 20 }: { readonly ask: Ask; readonly size?: number }) {
	switch (ask.kind) {
		case "question":
			return <ChatCircleDots size={size} weight="duotone" aria-label="Question" />;
		case "review":
			return <Eye size={size} weight="duotone" aria-label="Review" />;
		case "briefing":
			return <ListBullets size={size} weight="duotone" aria-label="Briefing" />;
		case "unknown":
			return <Question size={size} weight="duotone" aria-label="Can't be shown" />;
	}
}

/** The dot that means an agent is blocked on the person: the one place orange is used. */
export function WaitingDot({ tone = "waiting" }: { readonly tone?: "waiting" | "quiet" }) {
	return (
		<span
			aria-hidden
			className={`size-2 shrink-0 rounded-full ${
				tone === "waiting"
					? "bg-(--loopback-waiting) shadow-[0_0_0_3px_color-mix(in_oklch,var(--loopback-waiting)_22%,transparent)]"
					: "bg-(--text-color-kumo-inactive)"
			}`}
		/>
	);
}

/** That an agent is blocked on the ask right now. Nothing when it isn't: only waiting is news. */
export function Waiting({ ask }: { readonly ask: Ask }) {
	if (ask.status === "closed" || !ask.waiting) return null;
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 text-[15px] leading-[22px] font-semibold text-kumo-brand">
			<WaitingDot />
			Agent waiting
		</span>
	);
}

function Row({
	ask,
	selected,
	now,
}: {
	readonly ask: Ask;
	readonly selected: boolean;
	readonly now: number;
}) {
	const needing = pointsNeedingYou(ask);
	const meta = [ask.project, age(ask.closedAt ?? ask.updatedAt, now)].filter(
		(part): part is string => part !== undefined,
	);
	return (
		<AskLink
			askId={ask.id}
			aria-current={selected ? "page" : undefined}
			// The open ask takes the page's colour, over the list's edge, so it reads as a tab into it.
			className={`flex gap-3 px-5 py-3.5 transition-colors md:px-7 ${
				selected ? "bg-kumo-canvas" : "hover:bg-kumo-tint"
			}`}
		>
			<span className="flex h-[25px] w-5 shrink-0 items-center text-kumo-subtle">
				<KindIcon ask={ask} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-1.5">
				<span
					className={`text-[17px] leading-[25px] text-kumo-default ${
						ask.status === "awaiting_human" ? "font-semibold" : ""
					}`}
				>
					{headline(ask)}
				</span>
				<span className="flex items-center justify-between gap-3">
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[15px] leading-[22px] text-kumo-subtle">
						<span className="tabular-nums">{meta.join(" · ")}</span>
						{needing === 0 ? null : (
							<span className="font-semibold text-kumo-brand">{needing} need you</span>
						)}
					</span>
					<Waiting ask={ask} />
				</span>
			</span>
		</AskLink>
	);
}

const HEADING = "flex items-baseline gap-2 px-5 pb-1.5 text-left md:px-7";
const TITLE = "text-[20px] leading-7 font-bold tracking-[-0.01em] text-kumo-default";
const COUNT = "text-[20px] leading-7 text-kumo-subtle tabular-nums";

function Section({
	title,
	asks,
	selected,
	now,
	collapse,
}: {
	readonly title: string;
	readonly asks: readonly Ask[];
	readonly selected: string | null;
	readonly now: number;
	/** Makes the section foldable: its heading opens and closes it. */
	readonly collapse?: { readonly open: boolean; readonly toggle: () => void };
}) {
	if (asks.length === 0) return null;
	const open = collapse?.open ?? true;
	return (
		<section className="flex flex-col gap-0.5">
			{collapse === undefined ? (
				<h2 className={HEADING}>
					<span className={TITLE}>{title}</span>
					<span className={COUNT}>{asks.length}</span>
				</h2>
			) : (
				<h2>
					<button
						type="button"
						aria-expanded={open}
						onClick={collapse.toggle}
						className={`${HEADING} min-h-11 w-full items-center rounded-lg hover:bg-kumo-tint`}
					>
						<span className={TITLE}>{title}</span>
						<span className={COUNT}>{asks.length}</span>
						<span className="text-kumo-default">
							{open ? (
								<CaretDown size={18} weight="bold" />
							) : (
								<CaretRight size={18} weight="bold" />
							)}
						</span>
					</button>
				</h2>
			)}
			{open
				? asks.map((ask) => <Row key={ask.id} ask={ask} selected={ask.id === selected} now={now} />)
				: null}
		</section>
	);
}

/** Every ask in the inbox, grouped by whose move it is. */
export function AskList({
	inbox,
	selected,
}: {
	readonly inbox: InboxState;
	readonly selected: string | null;
}) {
	const now = useNow();
	const [recentOpen, toggleRecent] = useRecentOpen();
	const yours = inbox.open.filter((ask) => ask.status === "awaiting_human");
	const theirs = inbox.open.filter((ask) => ask.status === "awaiting_agent");
	return (
		<nav aria-label="Asks" className="flex flex-col gap-7 pb-8">
			{inbox.open.length === 0 ? (
				<p className="px-5 text-[17px] leading-[26px] text-kumo-subtle md:px-7">
					Nothing needs you right now.
				</p>
			) : null}
			<Section title="Your turn" asks={yours} selected={selected} now={now} />
			<Section title="Waiting on the agent" asks={theirs} selected={selected} now={now} />
			<Section
				title="Recent"
				asks={inbox.recent}
				selected={selected}
				now={now}
				collapse={{ open: recentOpen, toggle: toggleRecent }}
			/>
		</nav>
	);
}
