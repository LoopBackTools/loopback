import { Loader, Tabs } from "@cloudflare/kumo";
import { ShikiProvider } from "@cloudflare/kumo/code";
import { awaitingHuman } from "@loopbacktools/sdk";
import { CheckCircle, Tray } from "@phosphor-icons/react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useRef,
} from "react";
import { type InboxNavigation, NavigationContext, RootContext, useInbox } from "./context.tsx";
import { AskDetail } from "./detail.tsx";
import {
	type Filter,
	focusOf,
	nextAfter,
	onlyMine,
	shared,
	SIDEBAR,
	useFilter,
	useSidebarWidth,
} from "./hooks.ts";
import { AskList } from "./list.tsx";
import { useMe } from "./people.ts";
import { UpdateBanner } from "./update.tsx";

/** The languages review code is highlighted in; anything else is shown plain. */
const LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"html",
	"css",
	"python",
	"bash",
	"yaml",
	"toml",
	"sql",
	"markdown",
	"graphql",
	"hcl",
	"diff",
] as const;

/** The edge between the list and the ask: drag it, or focus it and use the arrow keys. */
function ResizeHandle({
	width,
	onResize,
}: {
	readonly width: number;
	readonly onResize: (width: number) => void;
}) {
	const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		drag.current = { x: event.clientX, width };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current !== null) onResize(drag.current.width + event.clientX - drag.current.x);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		drag.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") onResize(width - 16);
		else if (event.key === "ArrowRight") onResize(width + 16);
		else return;
		event.preventDefault();
	};
	return (
		// An <hr> is a static separator; a splitter that resizes is the focusable kind, which only
		// role="separator" can express.
		<div
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the inbox list"
			aria-valuenow={width}
			aria-valuemin={SIDEBAR.min}
			aria-valuemax={SIDEBAR.max}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onKeyDown={onKeyDown}
			className="relative z-10 -ml-1 hidden w-2 shrink-0 cursor-col-resize touch-none outline-none transition-colors hover:bg-kumo-line focus-visible:bg-kumo-brand md:block"
		/>
	);
}

/**
 * The inbox: every ask in a list, and the one open beside it, answered in place. It fills the
 * element it is drawn in, which needs a height. Which ask is open is the host's to keep, in its
 * own routes or anywhere else, through `selectedId`, `onSelect` and `hrefFor`. `header` sits at the
 * top of the list: the host's name, account and the like, which on a phone go with the list.
 */
export function Inbox({
	selectedId,
	onSelect,
	hrefFor,
	header,
}: InboxNavigation & { readonly header?: ReactNode }) {
	const root = useRef<HTMLDivElement>(null);
	const everything = useInbox();
	const me = useMe();
	const [filter, setFilter] = useFilter();
	// "Mine" is a choice only where other people's agents ask too.
	const choosing = shared(everything, me);
	const inbox =
		choosing && filter === "mine" && me !== undefined ? onlyMine(everything, me) : everything;
	// On a wide screen the top waiting ask opens by itself; on a phone the list comes first.
	const focusId = focusOf(inbox, selectedId);
	// An ask the person opened stays open, whichever asks the list shows.
	const selected =
		focusId === null
			? undefined
			: [...everything.open, ...everything.recent].find((ask) => ask.id === focusId);
	const [width, resize] = useSidebarWidth();
	// Once an ask is answered, open whatever else awaits the person; with nothing left, clear the
	// view so it shows that everything is done rather than the ask just answered.
	const advance = (answered: string) => onSelect(nextAfter(awaitingHuman(inbox), answered));
	const allDone = inbox.status === "live" && awaitingHuman(inbox).length === 0;

	return (
		<NavigationContext value={{ selectedId, onSelect, hrefFor }}>
			<RootContext value={root}>
				<ShikiProvider engine="javascript" languages={[...LANGUAGES]}>
					<div ref={root} className="flex h-full min-h-0 flex-1 flex-col bg-kumo-canvas">
						<UpdateBanner />
						<div className="flex min-h-0 flex-1">
							<aside
								style={{ "--sidebar": `${width}px` } as CSSProperties}
								// The edge is a shadow inside the list, not a border, so the open row can paint
								// over it and read as a tab into the ask beside it.
								className={`w-full overflow-y-auto bg-kumo-canvas md:block md:w-(--sidebar) md:shrink-0 md:bg-kumo-recessed md:shadow-[inset_-1px_0_0_var(--color-kumo-hairline)] ${
									selectedId === null ? "" : "hidden"
								}`}
							>
								{header === undefined ? null : (
									<div className="sticky top-0 z-10 bg-kumo-canvas md:bg-kumo-recessed md:shadow-[inset_-1px_0_0_var(--color-kumo-hairline)]">
										{header}
									</div>
								)}
								{choosing ? (
									<div className="px-5 pt-2 pb-4 md:px-7">
										<Tabs
											value={filter}
											onValueChange={(value) => setFilter(value as Filter)}
											tabs={[
												{ value: "all", label: "Everyone's" },
												{ value: "mine", label: "My agents'" },
											]}
										/>
									</div>
								) : null}
								<div className="pt-3">
									{inbox.status === "connecting" ? (
										<div className="flex justify-center p-8">
											<Loader />
										</div>
									) : inbox.open.length === 0 && inbox.recent.length === 0 ? (
										<EmptyState
											icon={<Tray size={44} weight="duotone" />}
											title="Nothing yet"
											description={
												inbox === everything
													? "When an agent asks you something, it appears here."
													: "When one of your agents asks something, it appears here."
											}
										/>
									) : (
										<AskList inbox={inbox} selected={focusId} />
									)}
								</div>
							</aside>
							<ResizeHandle width={width} onResize={resize} />
							<main
								className={`min-w-0 flex-1 overflow-y-auto bg-kumo-canvas md:block ${selectedId === null ? "hidden" : ""}`}
							>
								{selected !== undefined ? (
									<AskDetail ask={selected} onReplied={() => advance(selected.id)} />
								) : selectedId !== null && inbox.status === "live" ? (
									<EmptyState
										title="Not in the inbox"
										description="This ask is older than the inbox keeps."
									/>
								) : (
									<div className="hidden h-full items-center justify-center pb-24 md:flex">
										{allDone ? (
											<EmptyState
												icon={<CheckCircle size={48} weight="duotone" />}
												title="All done"
												description="Nothing needs you right now. When an agent asks, it appears here."
											/>
										) : null}
									</div>
								)}
							</main>
						</div>
					</div>
				</ShikiProvider>
			</RootContext>
		</NavigationContext>
	);
}

/** A calm, centred message where there is nothing to act on. */
function EmptyState({
	icon,
	title,
	description,
}: {
	readonly icon?: ReactNode;
	readonly title: string;
	readonly description: string;
}) {
	return (
		<div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center">
			{icon === undefined ? null : <span className="text-kumo-default">{icon}</span>}
			<h2 className="pt-2 text-[28px] leading-[34px] font-bold tracking-[-0.02em] text-kumo-strong">
				{title}
			</h2>
			<p className="text-[17px] leading-[26px] text-kumo-subtle">{description}</p>
		</div>
	);
}
