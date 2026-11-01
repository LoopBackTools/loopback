import { Button, DropdownMenu, LinkButton, Text } from "@cloudflare/kumo";
import { useAttention, useInbox, useNotifications } from "@loopbacktools/inbox";
import { Bell, BellSlash, CaretDown, Check, Plugs, Plus, SignOut } from "@phosphor-icons/react";
import { useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { connectPath, workspacePath } from "./paths.ts";
import type { MenuItem, SignedIn, WorkspaceSummary } from "./ports.ts";

const CONNECTION = {
	connecting: { label: "Connecting", tone: "bg-kumo-line" },
	live: { label: "Live", tone: "bg-kumo-success" },
	reconnecting: { label: "Reconnecting", tone: "bg-kumo-warning" },
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
				<Button variant="ghost" size="sm" icon={<CaretDown />}>
					{current?.name ?? "Workspace"}
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

/**
 * The person signed in: a menu of the deployment's items and signing out. With no items and no name
 * to show, signing out is a button of its own, and with nothing to sign out of either, there is none.
 */
function AccountMenu({
	signedIn,
	items,
}: {
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
	if (items.length === 0 && name === undefined) {
		return leave === undefined ? null : (
			<Button variant="ghost" size="sm" onClick={() => void leave()}>
				Sign out
			</Button>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button variant="ghost" size="sm">
					{name ?? "Account"}
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{items.map((item) => (
					<DropdownMenu.Item key={item.label} icon={item.icon} onClick={() => choose(item)}>
						{item.label}
					</DropdownMenu.Item>
				))}
				{leave === undefined ? null : (
					<>
						{items.length > 0 ? <DropdownMenu.Separator /> : null}
						<DropdownMenu.Item icon={SignOut} onClick={() => void leave()}>
							Sign out
						</DropdownMenu.Item>
					</>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/** The bar above a workspace's inbox. */
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
		<header className="flex items-center gap-2 border-b border-kumo-line bg-kumo-base px-4 py-2">
			<Link to={workspacePath(workspace)} className="flex items-center gap-2">
				<img src="/favicon.svg" alt="" className="size-6" />
				<Text bold>Loopback</Text>
			</Link>
			<WorkspaceMenu
				workspace={workspace}
				list={workspaces}
				items={workspaceItems}
				create={create}
			/>
			<span className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle">
				<span className={`size-2 rounded-full ${connection.tone}`} />
				{connection.label}
			</span>
			<span className="ml-auto flex items-center gap-1">
				<LinkButton href={connectPath(workspace)} variant="ghost" size="sm" icon={<Plugs />}>
					Connect an agent
				</LinkButton>
				{notifications.supported ? (
					<Button
						variant="ghost"
						size="sm"
						shape="square"
						aria-label={
							notifications.enabled ? "Turn notifications off" : "Notify me when an agent asks"
						}
						icon={notifications.enabled ? <Bell /> : <BellSlash />}
						onClick={() => void notifications.toggle()}
					/>
				) : null}
				<AccountMenu signedIn={signedIn} items={accountItems} />
			</span>
		</header>
	);
}
