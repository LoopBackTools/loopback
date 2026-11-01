import { Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { Link } from "react-router";

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
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
			<Link to={back.to} className="text-sm text-kumo-subtle">
				← {back.label}
			</Link>
			<div className="flex flex-col gap-2">
				<Text variant="heading" as="h1">
					{title}
				</Text>
				{description === undefined ? null : <Text variant="secondary">{description}</Text>}
			</div>
			{children}
		</main>
	);
}

/** One part of a page: a card with a heading. A dangerous one is bordered in red. */
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
			className={`flex flex-col gap-4 rounded-xl border bg-kumo-elevated p-5 ${
				danger ? "border-kumo-danger" : "border-kumo-line"
			}`}
		>
			<div className="flex flex-col gap-1">
				<Text bold>{title}</Text>
				{description === undefined ? null : (
					<Text variant="secondary" size="sm">
						{description}
					</Text>
				)}
			</div>
			{children}
		</section>
	);
}
