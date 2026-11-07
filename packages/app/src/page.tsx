import { Button } from "@cloudflare/kumo";
import { ArrowLeft, Check, Copy } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { Wordmark } from "./wordmark.tsx";

/** A page of its own, off the inbox: a way back, a heading, and its sections. */
export function Page({
	back,
	title,
	description,
	children,
}: {
	readonly back: { readonly to: string; readonly label: string };
	readonly title: string;
	readonly description?: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="min-h-full bg-kumo-canvas [--wordmark-ground:var(--color-kumo-canvas)]">
			<header className="hidden h-[84px] items-center px-7 md:flex">
				<Link to="/" className="rounded-md">
					<Wordmark />
				</Link>
			</header>
			<main className="mx-auto flex w-full max-w-[49rem] flex-col px-5 pt-4 pb-16 md:px-8 md:pt-0">
				<Link
					to={back.to}
					className="-ml-2 inline-flex min-h-11 w-fit items-center gap-2 rounded-lg px-2 text-[16px] font-medium text-kumo-default hover:bg-kumo-tint"
				>
					<ArrowLeft size={18} />
					{back.label}
				</Link>
				<h1 className="pt-4 text-[28px] leading-[34px] font-bold tracking-[-0.02em] text-kumo-strong md:pt-6 md:text-[34px] md:leading-[42px] md:tracking-[-0.025em]">
					{title}
				</h1>
				{description === undefined ? null : (
					<p className="pt-2 text-[16px] leading-6 text-(--loopback-body,var(--text-color-kumo-subtle)) md:pt-3.5 md:text-[17px] md:leading-7">
						{description}
					</p>
				)}
				<div className="flex flex-col gap-7 pt-7 md:gap-10 md:pt-11">{children}</div>
			</main>
		</div>
	);
}

/** One part of a page: a heading and what goes under it. A dangerous one is bordered in red. */
export function Section({
	title,
	description,
	danger = false,
	children,
}: {
	readonly title: string;
	readonly description?: string | undefined;
	readonly danger?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<section
			className={`flex flex-col gap-3 ${danger ? "rounded-lg border border-kumo-danger p-5" : ""}`}
		>
			<div className="flex flex-col gap-1">
				<h2 className="text-[18px] leading-[26px] font-bold text-kumo-default md:text-[20px] md:leading-7">
					{title}
				</h2>
				{description === undefined ? null : (
					<p className="text-[15px] leading-[22px] text-kumo-subtle">{description}</p>
				)}
			</div>
			{children}
		</section>
	);
}

/**
 * A command's parts that belong together: the command itself, each flag with its value, then each
 * argument. A narrow screen breaks the line between them, never inside `--transport`.
 */
export const commandParts = (command: string): string[] => {
	const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
	const parts: string[] = [];
	let seenFlag = false;
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at] ?? "";
		const next = tokens[at + 1];
		if (token.startsWith("-")) {
			seenFlag = true;
			if (next !== undefined && !next.startsWith("-")) {
				parts.push(`${token} ${next}`);
				at++;
			} else parts.push(token);
		} else if (!seenFlag && parts.length > 0) {
			parts[parts.length - 1] = `${parts[parts.length - 1]} ${token}`;
		} else parts.push(token);
	}
	return parts;
};

/**
 * Something to copy: a command, a URL, or words to paste to an agent, in a box with a Copy button.
 * A command keeps its parts whole when it wraps.
 */
export function CopyBox({
	text,
	command = false,
}: {
	readonly text: string;
	readonly command?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return undefined;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		await navigator.clipboard.writeText(text);
		setCopied(true);
	};
	return (
		<div className="flex items-start gap-3 rounded-lg border border-(--loopback-edge,var(--color-kumo-line)) bg-kumo-elevated py-2 pr-2 pl-4 md:py-3 md:pr-3 md:pl-[18px]">
			<p
				// A command wrapped onto a second line hangs under its first, so the parts read as one.
				className={`min-w-0 flex-1 py-2 text-[15px] leading-[23px] text-kumo-default md:text-[16px] md:leading-6 ${
					command ? "pl-4 -indent-4 font-medium" : ""
				}`}
			>
				{command
					? commandParts(text).map((part, index) => (
							// The parts of a command are its own, in order, and never change. The space before
							// each is outside it: that is where a line may break.
							// oxlint-disable-next-line react/no-array-index-key
							<Fragment key={index}>
								{index === 0 ? null : " "}
								<span className="whitespace-nowrap">{part}</span>
							</Fragment>
						))
					: text}
			</p>
			<Button
				size="lg"
				aria-label={copied ? "Copied" : "Copy"}
				icon={copied ? <Check /> : <Copy />}
				onClick={() => void copy()}
				className="shrink-0"
			>
				<span className="hidden md:inline">{copied ? "Copied" : "Copy"}</span>
			</Button>
		</div>
	);
}
