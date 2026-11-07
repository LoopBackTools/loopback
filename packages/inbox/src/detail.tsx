import { Banner, Button, DropdownMenu, InputArea } from "@cloudflare/kumo";
import { useAtomSet } from "@effect/atom-react";
import {
	ApiError,
	type Ask,
	type Entry,
	type QuestionAsk,
	type Reply,
	type ReplyBody,
	type UnknownAsk,
} from "@loopbacktools/sdk";
import {
	ArrowClockwise,
	ArrowLeft,
	Check,
	ChatTeardropText,
	DotsThree,
	PaperPlaneRight,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import { Cause, Exit } from "effect";
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { BriefingBody } from "./briefing.tsx";
import { Blocks, Prose } from "./content.tsx";
import { AskLink, useClient, useInboxKeys, useNavigation } from "./context.tsx";
import { age, useNow, useWide } from "./hooks.ts";
import { WaitingDot } from "./list.tsx";
import { reloadPage } from "./page.ts";
import { useMe, whoIs } from "./people.ts";
import { replyAtom } from "./state.ts";
import { AgentSaid, PersonSaid } from "./thread.tsx";

/** A reply in the words of the person who gave it. */
const said = (reply: Reply, who: string): { readonly title: string; readonly body?: string } => {
	switch (reply.outcome) {
		case "answered": {
			const chose =
				reply.selected.length === 0
					? `${who} answered`
					: `${who} chose ${reply.selected.join(", ")}`;
			return reply.text === undefined ? { title: chose } : { title: chose, body: reply.text };
		}
		case "approved":
			return reply.note === undefined
				? { title: `${who} approved` }
				: { title: `${who} approved`, body: reply.note };
		case "changes_requested":
			return { title: `${who} asked for changes`, body: reply.feedback };
		case "follow_up":
			return { title: `${who} asked`, body: reply.question };
		case "dismissed":
			return { title: `${who} dismissed this` };
		case "responded":
			return {
				title: `${who} replied on ${reply.points.length} ${reply.points.length === 1 ? "point" : "points"}`,
			};
		case "unknown":
			return { title: `${who} replied in a way this page can't show` };
	}
};

function Turn({ entry, now }: { readonly entry: Entry; readonly now: number }) {
	const me = useMe();
	if (entry.author === "agent") {
		return <AgentSaid answer={entry.answer} content={entry.content} at={entry.at} now={now} />;
	}
	const { title, body } = said(entry.reply, whoIs(entry.by, me));
	return <PersonSaid title={title} body={body} at={entry.at} now={now} />;
}

/** What the person has written or picked on a question or review, and not sent. */
interface Note {
	readonly text: string;
	readonly picked: readonly string[];
}

const NO_NOTE: Note = { text: "", picked: [] };

const noteKey = (askId: string) => `loopback.note.${askId}`;

/** A note kept in this browser, read as leniently as another version of this page may have left it. */
const readNote = (askId: string): Note => {
	try {
		const kept = JSON.parse(localStorage.getItem(noteKey(askId)) ?? "null") as {
			readonly text?: unknown;
			readonly picked?: unknown;
		} | null;
		return {
			text: typeof kept?.text === "string" ? kept.text : "",
			picked: Array.isArray(kept?.picked)
				? kept.picked.filter((label): label is string => typeof label === "string")
				: [],
		};
	} catch {
		return NO_NOTE;
	}
};

/**
 * Keeps what the person has written or picked on an ask, and not sent, in this browser, as a
 * briefing's drafts are: a reload onto a newer Loopback, or the agent's next turn, loses none of it.
 */
const useNote = (askId: string) => {
	const [note, setNote] = useState<Note>(() => readNote(askId));
	const keep = (next: Note) => {
		setNote(next);
		try {
			if (next.text === "" && next.picked.length === 0) localStorage.removeItem(noteKey(askId));
			else localStorage.setItem(noteKey(askId), JSON.stringify(next));
		} catch {
			// Storage can be unavailable (a private window); the note then lasts as long as the page.
		}
	};
	return {
		...note,
		setText: (text: string) => keep({ ...note, text }),
		setPicked: (change: (picked: readonly string[]) => readonly string[]) =>
			keep({ ...note, picked: change(note.picked) }),
		clear: () => keep(NO_NOTE),
	};
};

/** What failed when a reply was sent, in the person's terms. */
interface Failure {
	readonly title: string;
	readonly description: string;
}

/**
 * Replying to a question or review: the words and picks not yet sent, kept in this browser, and
 * sending them. Desktop and phone draw it differently, from this one state.
 */
const useReply = (ask: Ask, onReplied: () => void) => {
	const send = useAtomSet(replyAtom(useClient()), { mode: "promiseExit" });
	const note = useNote(ask.id);
	const [sending, setSending] = useState<string | null>(null);
	const [error, setError] = useState<Failure | null>(null);
	const words = note.text.trim();
	const question = ask.kind === "question" ? ask : null;

	const submit = async (key: string, reply: ReplyBody) => {
		setSending(key);
		setError(null);
		const exit = await send({ askId: ask.id, reply });
		setSending(null);
		if (Exit.isSuccess(exit)) {
			note.clear();
			onReplied();
			return;
		}
		// A reply Loopback refused will not go through as it is; one that never reached it, or met
		// a fault there, can simply be sent again. Either way the agent has nothing yet.
		const failure = Cause.squash(exit.cause);
		const reason = failure instanceof Error ? failure.message : "no reason given";
		setError(
			failure instanceof ApiError && failure.status >= 400 && failure.status < 500
				? { title: "Your reply was not accepted", description: reason }
				: {
						title: "Your reply was not sent",
						description: `Loopback could not take it just now (${reason}), so the agent still has nothing. Send it again.`,
					},
		);
	};
	const withText = words === "" ? {} : { text: words };

	const choose = (label: string) => {
		if (question === null) return;
		if (question.prompt.multiple) {
			note.setPicked((current) =>
				current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
			);
		} else {
			void submit(label, { outcome: "answered", selected: [label], ...withText });
		}
	};

	const moves = {
		send: () =>
			void submit("send", { outcome: "answered", selected: [...note.picked], ...withText }),
		approve: () =>
			void submit("approve", { outcome: "approved", ...(words === "" ? {} : { note: words }) }),
		changes: () => void submit("changes", { outcome: "changes_requested", feedback: words }),
		ask: () => void submit("ask", { outcome: "follow_up", question: words }),
		dismiss: () => void submit("dismiss", { outcome: "dismissed" }),
	};

	/** The main reply, as ⌘↵ sends it: the answer to a question, or approval of a review. */
	const primary = (): (() => void) | null =>
		question !== null
			? note.picked.length > 0 || words !== ""
				? moves.send
				: null
			: moves.approve;

	return {
		...note,
		words,
		question,
		sending,
		busy: sending !== null,
		error,
		choose,
		moves,
		primary,
	};
};

type Replying = ReturnType<typeof useReply>;

function SendError({ error }: { readonly error: Failure | null }) {
	return error === null ? null : (
		<Banner
			role="alert"
			variant="error"
			icon={<WarningCircle />}
			title={error.title}
			description={error.description}
		/>
	);
}

/** The ⌘↵ and 1-9 shortcuts, while the ask is open on a wide screen. */
function useReplyKeys(reply: Replying) {
	// ⌘↵ (Ctrl↵ off Apple's keyboards) sends the main reply wherever focus is, since an ask that opens
	// by itself has nothing focused; 1-9 pick a choice while the reply box does not have focus.
	useInboxKeys((event) => {
		if (reply.busy) return;
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			const move = reply.primary();
			if (move === null) return;
			event.preventDefault();
			move();
			return;
		}
		const target = event.target as HTMLElement | null;
		if (reply.question === null || event.metaKey || event.ctrlKey) return;
		if (target?.closest("input, textarea, [contenteditable]")) return;
		const option = reply.question.prompt.options[Number(event.key) - 1];
		if (option !== undefined) reply.choose(option.label);
	});
}

/** On a wide screen: the choices, then a box for words, then every move this kind of ask allows. */
function ReplyPanel({ reply }: { readonly reply: Replying }) {
	useReplyKeys(reply);
	const { question, busy, sending, moves, words } = reply;
	const options = question?.prompt.options ?? [];
	return (
		<div className="flex flex-col gap-3 pt-8">
			<SendError error={reply.error} />
			{question === null || options.length === 0 ? null : (
				<Choices
					question={question}
					picked={reply.picked}
					busy={busy}
					sending={sending}
					onChoose={reply.choose}
					hint={
						question.prompt.multiple
							? "Pick any that apply, then send."
							: "Picking one sends it, along with any note you've written below."
					}
				/>
			)}
			<div className={question !== null && options.length > 0 ? "pt-6" : ""}>
				<InputArea
					label={
						question === null
							? "Note or feedback"
							: options.length === 0
								? "Your answer"
								: "Or reply in your own words"
					}
					placeholder={
						question === null
							? "What to change, or a note to go with your approval"
							: options.length === 0
								? "Your answer, or a question back"
								: "Add a note, give a different answer, or ask a question back"
					}
					value={reply.text}
					onValueChange={reply.setText}
					autoResize
					minRows={3}
					maxRows={12}
					disabled={busy}
					className="text-[17px] leading-[26px]"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-2 pt-1">
				{question === null ? (
					<>
						<Button
							variant="primary"
							data-primary=""
							size="lg"
							icon={<Check />}
							aria-keyshortcuts="Meta+Enter Control+Enter"
							loading={sending === "approve"}
							disabled={busy}
							onClick={moves.approve}
						>
							Approve
						</Button>
						<Button
							size="lg"
							loading={sending === "changes"}
							disabled={busy || words === ""}
							onClick={moves.changes}
						>
							Request changes
						</Button>
					</>
				) : (
					<Button
						variant="primary"
						data-primary=""
						size="lg"
						icon={<PaperPlaneRight />}
						aria-keyshortcuts="Meta+Enter Control+Enter"
						loading={sending === "send"}
						disabled={busy || (reply.picked.length === 0 && words === "")}
						onClick={moves.send}
					>
						Send
					</Button>
				)}
				<Button
					size="lg"
					icon={<ChatTeardropText />}
					loading={sending === "ask"}
					disabled={busy || words === ""}
					onClick={moves.ask}
				>
					Ask back
				</Button>
				<Button
					variant="ghost"
					size="lg"
					icon={<X />}
					loading={sending === "dismiss"}
					disabled={busy}
					onClick={moves.dismiss}
					// Its words line up with the box's edge; the padding hangs past it.
					className="-mr-4 ml-auto"
				>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

function Choices({
	question,
	picked,
	busy,
	sending,
	onChoose,
	hint,
	compact = false,
}: {
	readonly question: QuestionAsk;
	readonly picked: readonly string[];
	readonly busy: boolean;
	readonly sending: string | null;
	readonly onChoose: (label: string) => void;
	readonly hint: string;
	/** A phone's: tighter, with the description smaller than the choice. */
	readonly compact?: boolean;
}) {
	return (
		<div className="flex flex-col gap-2">
			{question.prompt.options.map((option, index) => {
				const on = picked.includes(option.label);
				return (
					<button
						key={option.label}
						type="button"
						disabled={busy}
						aria-pressed={question.prompt.multiple ? on : undefined}
						onClick={() => onChoose(option.label)}
						className={`flex min-h-14 items-start text-left transition-colors disabled:opacity-60 ${
							compact ? "gap-3 rounded-lg px-3.5 py-3" : "gap-4 rounded-lg px-5 py-4"
						} border ${
							on
								? "border-kumo-brand bg-kumo-tint"
								: "border-(--loopback-edge) bg-kumo-elevated hover:bg-kumo-tint"
						}`}
					>
						<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-kumo-line text-[15px] font-semibold text-kumo-default tabular-nums">
							{sending === option.label ? "…" : index + 1}
						</span>
						<span className="flex min-w-0 flex-col gap-0.5 pt-px">
							<span className="text-[17px] leading-6 font-semibold text-kumo-default">
								{option.label}
							</span>
							{option.description === undefined ? null : (
								<span
									className={`text-kumo-subtle ${compact ? "text-[15px] leading-[21px]" : "text-[17px] leading-[26px]"}`}
								>
									{option.description}
								</span>
							)}
						</span>
					</button>
				);
			})}
			<p className="pt-1 text-[15px] leading-[22px] text-kumo-subtle">{hint}</p>
		</div>
	);
}

/** What the phone's composer is for, beyond answering a question: a review's other moves. */
type Mode = "changes" | "ask" | "note";

const MODE: Record<
	Mode,
	{ readonly title: string; readonly placeholder: string; readonly action: string }
> = {
	changes: {
		title: "Requesting changes",
		placeholder: "What should change?",
		action: "Send changes",
	},
	ask: { title: "Asking back", placeholder: "Your question for the agent", action: "Ask back" },
	note: { title: "Approving with a note", placeholder: "Your note", action: "Approve" },
};

/** Fits a box to what is written in it, up to seven lines; beyond that it scrolls. */
const fit = (box: HTMLTextAreaElement) => {
	box.style.height = "auto";
	box.style.height = `${Math.min(box.scrollHeight, 168)}px`;
};

/** A box that grows with what is written in it. */
function GrowingText({
	value,
	onChange,
	placeholder,
	label,
	disabled,
	focus,
	rows,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly placeholder: string;
	readonly label: string;
	readonly disabled: boolean;
	/** Whether the person just asked for the box, by tapping a move that needs words. */
	readonly focus: boolean;
	readonly rows: number;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (focus) box.current?.focus();
	}, [focus]);
	return (
		<textarea
			// Fitted on every render, so it shrinks back when the box folds to one line as well as when
			// it is written in.
			ref={(element) => {
				box.current = element;
				if (element !== null) fit(element);
			}}
			aria-label={label}
			value={value}
			onChange={(event) => {
				onChange(event.target.value);
				fit(event.target);
			}}
			placeholder={placeholder}
			disabled={disabled}
			rows={rows}
			className="min-w-0 flex-1 resize-none bg-transparent text-[17px] leading-6 text-kumo-default outline-none placeholder:text-kumo-placeholder"
		/>
	);
}

const CAPSULE = "h-10 rounded-full px-4";

/**
 * On a phone, the reply sits at the bottom of the screen, over a fade, within reach of a thumb. A
 * question's is a box that grows once written in, with its moves inside it; a review's is its two
 * moves, the box appearing only for one that needs words.
 */
function Chin({
	reply,
	mode,
	setMode,
}: {
	readonly reply: Replying;
	readonly mode: Mode | null;
	readonly setMode: (mode: Mode | null) => void;
}) {
	const { question, busy, sending, moves, words } = reply;
	const [focused, setFocused] = useState(false);
	const review = question === null;
	const composing = review ? mode !== null : focused || reply.text !== "";
	const shown = mode === null ? null : MODE[mode];
	return (
		<div className="sticky bottom-0 z-10 -mx-5 mt-auto flex flex-col gap-2 bg-linear-to-b from-transparent via-kumo-canvas/90 via-40% to-kumo-canvas px-3 pt-8 pb-[max(env(safe-area-inset-bottom),12px)]">
			<SendError error={reply.error} />
			{review && mode === null ? (
				<div className="flex gap-2.5">
					<Button
						size="lg"
						className="h-[52px] flex-1 justify-center rounded-full text-[17px]"
						disabled={busy}
						onClick={() => setMode("changes")}
					>
						Request changes
					</Button>
					<Button
						variant="primary"
						data-primary=""
						size="lg"
						icon={<Check />}
						className="h-[52px] flex-1 justify-center rounded-full text-[17px]"
						loading={sending === "approve"}
						disabled={busy}
						onClick={moves.approve}
					>
						Approve
					</Button>
				</div>
			) : (
				<div
					onFocus={() => setFocused(true)}
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
					}}
					className={`flex border bg-kumo-base shadow-lg transition-[border-radius] ${
						composing
							? "flex-col gap-2.5 rounded-[22px] border-kumo-brand py-2.5 pr-2 pl-4"
							: "items-center gap-2.5 rounded-full border-kumo-line py-1.5 pr-1.5 pl-[18px]"
					}`}
				>
					{shown === null ? null : (
						<div className="flex items-center justify-between">
							<span className="text-[15px] leading-[22px] font-semibold text-kumo-subtle">
								{shown.title}
							</span>
							<Button
								variant="ghost"
								shape="circle"
								aria-label="Cancel"
								icon={<X />}
								onClick={() => setMode(null)}
							/>
						</div>
					)}
					<div className="flex min-w-0 flex-1 items-center gap-2.5">
						<GrowingText
							value={reply.text}
							onChange={reply.setText}
							placeholder={shown?.placeholder ?? "Reply in your own words"}
							label={shown?.title ?? "Your answer, or a note"}
							disabled={busy}
							focus={shown !== null}
							rows={composing ? 2 : 1}
						/>
						{composing ? null : (
							<Button
								shape="circle"
								aria-label="Send"
								icon={<PaperPlaneRight />}
								className="size-10 shrink-0"
								disabled
							/>
						)}
					</div>
					{!composing ? null : (
						<div className="flex justify-end gap-2">
							{mode === null ? (
								<>
									<Button
										icon={<ChatTeardropText />}
										className={CAPSULE}
										loading={sending === "ask"}
										disabled={busy || words === ""}
										onClick={moves.ask}
									>
										Ask back
									</Button>
									<Button
										variant="primary"
										data-primary=""
										icon={<PaperPlaneRight />}
										className={CAPSULE}
										loading={sending === "send"}
										disabled={busy || (reply.picked.length === 0 && words === "")}
										onClick={moves.send}
									>
										Send
									</Button>
								</>
							) : (
								<Button
									variant="primary"
									data-primary=""
									icon={mode === "note" ? <Check /> : <PaperPlaneRight />}
									className={CAPSULE}
									loading={sending !== null}
									disabled={busy || (mode !== "note" && words === "")}
									onClick={
										mode === "changes" ? moves.changes : mode === "ask" ? moves.ask : moves.approve
									}
								>
									{shown?.action}
								</Button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** The top of an ask on a phone: the way back to the list, and the moves too rare for the chin. */
function PhoneBar({
	items,
}: {
	readonly items: readonly { readonly label: string; readonly onSelect: () => void }[];
}) {
	const { onSelect } = useNavigation();
	return (
		<div className="sticky top-0 z-10 -mx-5 flex h-11 items-center justify-between bg-kumo-canvas px-1.5">
			<Button
				variant="ghost"
				size="lg"
				icon={<ArrowLeft size={20} />}
				onClick={() => onSelect(null)}
				className="text-[17px]"
			>
				Inbox
			</Button>
			{items.length === 0 ? null : (
				<DropdownMenu>
					<DropdownMenu.Trigger>
						<Button
							variant="ghost"
							shape="square"
							size="lg"
							aria-label="More"
							icon={<DotsThree size={24} weight="bold" />}
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						{items.map((item) => (
							<DropdownMenu.Item key={item.label} onClick={item.onSelect}>
								{item.label}
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu>
			)}
		</div>
	);
}

/** An ask the person is to answer: the ask itself, then the reply, laid out for the screen. */
function Answering({
	ask,
	onReplied,
	wide,
	children,
}: {
	readonly ask: Exclude<Ask, UnknownAsk>;
	readonly onReplied: () => void;
	readonly wide: boolean;
	readonly children: ReactNode;
}) {
	const reply = useReply(ask, onReplied);
	const [mode, setMode] = useState<Mode | null>(null);
	if (wide) {
		return (
			<Frame>
				{children}
				<ReplyPanel reply={reply} />
			</Frame>
		);
	}
	const question = reply.question;
	return (
		<Frame
			bar={
				<PhoneBar
					items={[
						...(question === null
							? [
									{ label: "Ask back", onSelect: () => setMode("ask") },
									{ label: "Approve with a note", onSelect: () => setMode("note") },
								]
							: []),
						{ label: "Dismiss", onSelect: reply.moves.dismiss },
					]}
				/>
			}
			chin={<Chin reply={reply} mode={mode} setMode={setMode} />}
		>
			{children}
			{question === null || question.prompt.options.length === 0 ? null : (
				<div className="pt-5">
					<Choices
						question={question}
						picked={reply.picked}
						busy={reply.busy}
						sending={reply.sending}
						onChoose={reply.choose}
						hint={
							question.prompt.multiple ? "Tap any that apply, then send." : "Tap one to send it."
						}
						compact
					/>
				</div>
			)}
		</Frame>
	);
}

/**
 * The column an ask is read in: centred on a wide screen, the full width of a phone, with the
 * phone's bar at the top and its reply at the bottom.
 */
function Frame({
	bar,
	chin,
	children,
}: {
	readonly bar?: ReactNode;
	readonly chin?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<article className="mx-auto flex min-h-full w-full max-w-[49rem] flex-col px-5 pb-0 md:px-8 md:pt-12 md:pb-16">
			{bar}
			<div className="flex flex-col pb-6 md:pb-0">{children}</div>
			{chin}
		</article>
	);
}

const nothing = () => {};

/**
 * An ask the inbox could not draw, with the moves still open to the person: dismissing it, and, for
 * one sent by a newer version of Loopback than this page, reloading to see it.
 */
function CannotShow({
	ask,
	onReplied,
	newer = false,
}: {
	readonly ask: Ask;
	readonly onReplied: () => void;
	/** Whether it is an ask of a kind this page doesn't know, from a newer version. */
	readonly newer?: boolean;
}) {
	const { onSelect } = useNavigation();
	const send = useAtomSet(replyAtom(useClient()), { mode: "promiseExit" });
	const [sending, setSending] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const dismiss = async () => {
		setSending(true);
		setFailed(null);
		const exit = await send({ askId: ask.id, reply: { outcome: "dismissed" } });
		setSending(false);
		if (Exit.isSuccess(exit)) {
			onReplied();
			return;
		}
		const failure = Cause.squash(exit.cause);
		setFailed(failure instanceof Error ? failure.message : "no reason given");
	};
	return (
		<article className="mx-auto flex w-full max-w-[49rem] flex-col gap-4 px-5 py-4 md:px-8 md:pt-12">
			<button
				type="button"
				onClick={() => onSelect(null)}
				className="inline-flex min-h-11 w-fit items-center gap-1.5 text-[17px] text-kumo-default md:hidden"
			>
				<ArrowLeft size={20} /> Inbox
			</button>
			<Banner
				variant="error"
				icon={<WarningCircle />}
				title="This ask can't be shown"
				description={
					newer
						? "It came from a newer version of Loopback than this page. Reload the page to see it."
						: "It doesn't match what this inbox knows how to draw, perhaps because it was sent while Loopback was being updated. Dismiss it, and the agent can send it again."
				}
			/>
			{failed === null ? null : (
				<Banner
					role="alert"
					variant="error"
					icon={<WarningCircle />}
					title="It was not dismissed"
					description={failed}
				/>
			)}
			<div className="flex gap-2">
				{newer ? (
					<Button
						className="w-fit"
						variant="secondary"
						size="lg"
						icon={<ArrowClockwise />}
						onClick={reloadPage}
					>
						Reload
					</Button>
				) : null}
				{ask.status === "closed" ? null : (
					<Button
						className="w-fit"
						variant="ghost"
						size="lg"
						icon={<X />}
						loading={sending}
						onClick={() => void dismiss()}
					>
						Dismiss
					</Button>
				)}
			</div>
		</article>
	);
}

/** Keeps one ask that cannot be drawn from taking the whole inbox down with it. */
class Drawable extends Component<
	{ readonly ask: Ask; readonly onReplied: () => void; readonly children: ReactNode },
	{ readonly failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch(error: unknown) {
		console.error(`Ask ${this.props.ask.id} could not be shown:`, error);
	}

	override render() {
		return this.state.failed ? (
			<CannotShow ask={this.props.ask} onReplied={this.props.onReplied} />
		) : (
			this.props.children
		);
	}
}

export function AskDetail({
	ask,
	onReplied = nothing,
}: {
	readonly ask: Ask;
	/** Called once a reply is sent: the inbox moves on to whatever is next. */
	readonly onReplied?: () => void;
}) {
	if (ask.kind === "unknown") return <CannotShow ask={ask} onReplied={onReplied} newer />;
	return (
		<Drawable key={ask.id} ask={ask} onReplied={onReplied}>
			<AskView ask={ask} onReplied={onReplied} />
		</Drawable>
	);
}

/** A client's name as the person knows it: `claude-code 2.0.31` is Claude Code. */
export const clientName = (client: string): string =>
	client
		.replace(/\s+v?\d[\w.+-]*$/, "")
		.split(/[-_\s]+/)
		.filter((word) => word !== "")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

/** Who asked, where, and when, as a sentence: "Claude Code in billing-api asked 2 min ago". */
function AskedBy({ ask, now }: { readonly ask: Exclude<Ask, UnknownAsk>; readonly now: number }) {
	const me = useMe();
	const who =
		ask.raisedBy?.name !== undefined && ask.raisedBy.id !== me
			? `${ask.raisedBy.name}'s agent`
			: ask.client === undefined
				? "Your agent"
				: clientName(ask.client);
	const when = age(ask.createdAt, now);
	const verb = ask.kind === "briefing" ? "sent this" : "asked";
	return (
		<span className="text-[15px] leading-[22px] text-kumo-subtle">
			{who}
			{ask.project === undefined ? null : (
				<>
					{" in "}
					<span className="font-semibold text-kumo-default">{ask.project}</span>
				</>
			)}{" "}
			{verb} {when === "just now" ? when : `${when} ago`}
		</span>
	);
}

/** Whose move it is, in words: orange only when an agent is blocked on the person. */
function Status({ ask }: { readonly ask: Exclude<Ask, UnknownAsk> }) {
	if (ask.status === "awaiting_human") {
		return ask.waiting ? (
			<span className="inline-flex items-center gap-1.5 text-[15px] leading-[22px] font-semibold text-kumo-brand">
				<WaitingDot />
				Waiting for your answer
			</span>
		) : null;
	}
	return (
		<span className="inline-flex items-center gap-1.5 text-[15px] leading-[22px] font-medium text-kumo-subtle">
			<WaitingDot tone="quiet" />
			{ask.status === "awaiting_agent" ? "Waiting on the agent" : "Closed"}
		</span>
	);
}

/**
 * The ask, at the size of a headline: a short question or a title reads as the page's heading; a
 * question long enough to be a paragraph is set smaller, so it stays easy to read.
 */
const HEADLINE =
	"text-[24px] leading-[30px] font-bold tracking-[-0.02em] text-kumo-strong [--prose-leading:30px] md:text-[34px] md:leading-[42px] md:tracking-[-0.025em] md:[--prose-leading:42px]";
const LONG_QUESTION =
	"text-[20px] leading-7 font-semibold text-kumo-strong [--prose-leading:28px] md:text-[22px] md:leading-[30px] md:[--prose-leading:30px]";
const BODY =
	"text-[16px] text-(--loopback-body) [--prose-leading:24px] md:text-[17px] md:[--prose-leading:28px]";

/** One ask: what the agent wants, the thread so far, and the moves left. */
function AskView({
	ask,
	onReplied,
}: {
	readonly ask: Exclude<Ask, UnknownAsk>;
	readonly onReplied: () => void;
}) {
	const now = useNow();
	const wide = useWide();
	const content = (
		<>
			<header className="flex flex-col">
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-3 md:justify-start md:pb-4">
					<AskedBy ask={ask} now={now} />
					<Status ask={ask} />
				</div>
				{ask.kind === "question" ? (
					// A question is markdown, and its paragraphs can't sit inside an h1; the role gives it the
					// heading's place in the page's outline all the same.
					// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
					<div role="heading" aria-level={1}>
						<Prose
							text={ask.prompt.question}
							className={ask.prompt.question.length > 140 ? LONG_QUESTION : HEADLINE}
						/>
					</div>
				) : (
					<h1 className={HEADLINE}>{ask.prompt.title}</h1>
				)}
				{ask.kind !== "review" || ask.revises === undefined ? null : (
					<AskLink
						askId={ask.revises}
						className="pt-2 text-[15px] text-kumo-default underline underline-offset-2"
					>
						Revises an earlier review
					</AskLink>
				)}
				{ask.kind === "question" ? (
					ask.prompt.context === undefined ? null : (
						<div className="pt-3 md:pt-4">
							<Prose text={ask.prompt.context} className={BODY} />
						</div>
					)
				) : ask.prompt.summary === undefined ? null : (
					<div className="pt-3 md:pt-4">
						<Prose text={ask.prompt.summary} className={BODY} />
					</div>
				)}
			</header>

			{ask.kind === "briefing" ? (
				<div className="pt-6">
					<BriefingBody key={ask.id} ask={ask} onReplied={onReplied} />
				</div>
			) : ask.kind === "review" ? (
				<div className="pt-6 text-[17px] md:pt-7">
					<Blocks blocks={ask.prompt.content} />
				</div>
			) : null}

			{ask.kind === "briefing" || ask.thread.length === 0 ? null : (
				<div className="flex flex-col gap-4 pt-8">
					{ask.thread.map((entry) => (
						<Turn key={`${entry.author}:${entry.at}`} entry={entry} now={now} />
					))}
				</div>
			)}
		</>
	);

	if (ask.kind !== "briefing" && ask.status === "awaiting_human") {
		return (
			<Answering key={`${ask.id}:${ask.thread.length}`} ask={ask} onReplied={onReplied} wide={wide}>
				{content}
			</Answering>
		);
	}
	return (
		<Frame bar={wide ? undefined : <PhoneBar items={[]} />}>
			{content}
			{ask.kind !== "briefing" && ask.status === "awaiting_agent" ? (
				<p className="flex items-start gap-2.5 pt-6 text-[17px] leading-[26px] text-kumo-subtle">
					<span className="flex h-[26px] items-center">
						<WaitingDot tone="quiet" />
					</span>
					<span>The agent has your question and will answer here.</span>
				</p>
			) : null}
		</Frame>
	);
}
