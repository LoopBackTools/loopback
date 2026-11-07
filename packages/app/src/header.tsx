import { Button, DropdownMenu } from "@cloudflare/kumo";
import { useAttention, useInbox, useNotifications } from "@loopbacktools/inbox";
import {
	ArrowClockwise,
	Bell,
	BellSlash,
	CaretDown,
	Check,
	Plugs,
	Plus,
	SignOut,
	UserCircle,
} from "@phosphor-icons/react";
import { useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { connectPath, workspacePath } from "./paths.ts";
import type { MenuItem, SignedIn, WorkspaceSummary } from "./ports.ts";
import { Wordmark } from "./wordmark.tsx";

/** The connection, only while it isn't live: a dot that says "Live" all day is noise. */
const CONNECTION = {
	connecting: "Connecting",
	live: null,
	reconnecting: "Reconnecting",
} as const;

/** Goes where a menu item goes, or does what it does. */
const useChoose = () => {
	const navigate = useNavigate();
	return (item: MenuItem) => {
		if (item.to !== undefined) void navigate(item.to);
		void item.onSelect?.();
	};
};

/**
 * The workspace open, and the way to the others: only where there is more than one, or a way to make
 * one, or the deployment has items of its own for it.
 */
function WorkspaceMenu({
	workspace,
	list,
	items,
	create,
}: {
	readonly workspace: string;
	readonly list: readonly WorkspaceSummary[];
	readonly items: readonly MenuItem[];
	readonly create: (() => Promise<string | undefined>) | undefined;
}) {
	const navigate = useNavigate();
	const choose = useChoose();
	if (list.length < 2 && create === undefined && items.length === 0) return null;
	const current = list.find((candidate) => candidate.id === workspace);
	const make = async () => {
		const id = await create?.();
		if (id !== undefined) await navigate(workspacePath(id));
	};
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button variant="ghost" icon={<CaretDown />} className="min-w-0 text-[15px]">
					<span className="truncate">{current?.name ?? "Workspace"}</span>
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{list.map((candidate) => (
					<DropdownMenu.Item
						key={candidate.id}
						icon={candidate.id === workspace ? Check : undefined}
						onClick={() => void navigate(workspacePath(candidate.id))}
					>
						{candidate.name}
					</DropdownMenu.Item>
				))}
				{items.length > 0 || create !== undefined ? <DropdownMenu.Separator /> : null}
				{items.map((item) => (
					<DropdownMenu.Item key={item.label} icon={item.icon} onClick={() => choose(item)}>
						{item.label}
					</DropdownMenu.Item>
				))}
				{create === undefined ? null : (
					<DropdownMenu.Item icon={Plus} onClick={() => void make()}>
						New workspace
					</DropdownMenu.Item>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/** Initials for the avatar: "Zach Bimson" is ZB. */
const initials = (name: string): string =>
	name
		.split(/\s+/)
		.filter((word) => word !== "")
		.slice(0, 2)
		.map((word) => word.charAt(0).toUpperCase())
		.join("");

/**
 * The person: their avatar, opening the way to connect an agent, the deployment's own items, and
 * signing out, when there is something to sign out of.
 */
function AccountMenu({
	workspace,
	signedIn,
	items,
}: {
	readonly workspace: string;
	readonly signedIn: SignedIn;
	readonly items: readonly MenuItem[];
}) {
	const navigate = useNavigate();
	const choose = useChoose();
	const { name, signOut } = signedIn;
	const leave =
		signOut === undefined
			? undefined
			: async () => {
					await signOut();
					await navigate("/");
				};
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button
					variant="ghost"
					shape="square"
					size="lg"
					aria-label={name === undefined ? "Account" : `Account: ${name}`}
					icon={
						name === undefined ? (
							<UserCircle size={26} />
						) : (
							<span className="flex size-8 items-center justify-center rounded-full bg-kumo-brand text-[14px] font-semibold text-kumo-inverse">
								{initials(name)}
							</span>
						)
					}
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{name === undefined ? null : (
					<>
						<DropdownMenu.Group>
							<DropdownMenu.Label>{name}</DropdownMenu.Label>
						</DropdownMenu.Group>
						<DropdownMenu.Separator />
					</>
				)}
				<DropdownMenu.Item icon={Plugs} onClick={() => void navigate(connectPath(workspace))}>
					Connect an agent
				</DropdownMenu.Item>
				{items.map((item) => (
					<DropdownMenu.Item key={item.label} icon={item.icon} onClick={() => choose(item)}>
						{item.label}
					</DropdownMenu.Item>
				))}
				{leave === undefined ? null : (
					<>
						<DropdownMenu.Separator />
						<DropdownMenu.Item icon={SignOut} onClick={() => void leave()}>
							Sign out
						</DropdownMenu.Item>
					</>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/**
 * The top of the inbox's list: Loopback's wordmark, the workspace where there is a choice, the
 * connection while it's down, notifications, and the person's menu.
 */
export function Header({
	workspace,
	signedIn,
	workspaces,
	workspaceItems,
	accountItems,
	create,
}: {
	readonly workspace: string;
	readonly signedIn: SignedIn;
	/** Every workspace the person can open. */
	readonly workspaces: readonly WorkspaceSummary[];
	readonly workspaceItems: readonly MenuItem[];
	readonly accountItems: readonly MenuItem[];
	readonly create: (() => Promise<string | undefined>) | undefined;
}) {
	const navigate = useNavigate();
	const inbox = useInbox();
	const notifications = useNotifications();
	const open = useCallback(
		(askId: string) => void navigate(workspacePath(workspace, askId)),
		[navigate, workspace],
	);
	useAttention(inbox, notifications.enabled, open);
	const connection = CONNECTION[inbox.status];
	return (
		<header
			// The wordmark is cut out of the list it sits on: the page's colour on a phone, the list's beside it.
			className="flex min-h-[72px] items-center gap-2 py-3.5 pr-3 pl-5 [--wordmark-ground:var(--color-kumo-canvas)] md:min-h-[84px] md:pl-7 md:[--wordmark-ground:var(--color-kumo-recessed)]"
		>
			<Link to={workspacePath(workspace)} className="shrink-0 rounded-md">
				<Wordmark />
			</Link>
			<WorkspaceMenu
				workspace={workspace}
				list={workspaces}
				items={workspaceItems}
				create={create}
			/>
			{connection === null ? null : (
				<output className="inline-flex items-center gap-1.5 text-[15px] font-medium text-kumo-subtle">
					<ArrowClockwise size={16} />
					{connection}
				</output>
			)}
			<span className="ml-auto flex shrink-0 items-center gap-1">
				{notifications.supported ? (
					<Button
						variant="ghost"
						size="lg"
						shape="square"
						aria-label={
							notifications.enabled ? "Turn notifications off" : "Notify me when an agent asks"
						}
						icon={notifications.enabled ? <Bell size={22} /> : <BellSlash size={22} />}
						onClick={() => void notifications.toggle()}
					/>
				) : null}
				<AccountMenu workspace={workspace} signedIn={signedIn} items={accountItems} />
			</span>
		</header>
	);
}
