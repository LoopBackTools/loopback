import { Button, Input, Text } from "@cloudflare/kumo";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit } from "effect";
import { type FormEvent, useState } from "react";
import { signInAtom, tokenAtom } from "./session.ts";

/** Signing in with the token the deployment was set up with. */
export function SignIn() {
	const setToken = useAtomSet(tokenAtom);
	const signIn = useAtomSet(signInAtom, { mode: "promiseExit" });
	const [token, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const exit = await signIn(token.trim());
		setBusy(false);
		if (Exit.isSuccess(exit)) {
			setToken(exit.value.token);
			return;
		}
		const failure = Cause.squash(exit.cause);
		setError(failure instanceof Error ? failure.message : "That token was not accepted.");
	};

	return (
		<main className="flex h-full items-center justify-center p-4">
			<form
				onSubmit={(event) => void submit(event)}
				className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-elevated p-6"
			>
				<div className="flex flex-col gap-1">
					<Text variant="heading" as="h1">
						Loopback
					</Text>
					<Text variant="secondary">Paste the token this deployment was set up with.</Text>
				</div>
				<Input
					label="Token"
					type="password"
					autoComplete="current-password"
					value={token}
					onChange={(event) => setDraft(event.target.value)}
					{...(error === null ? {} : { error })}
				/>
				<Button type="submit" variant="primary" loading={busy} disabled={token.trim() === ""}>
					Open the inbox
				</Button>
			</form>
		</main>
	);
}
