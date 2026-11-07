import { Button, Input } from "@cloudflare/kumo";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit } from "effect";
import { type FormEvent, useState } from "react";
import { signInAtom, tokenAtom } from "./session.ts";

/** Loopback's mark, the loop and its arrowhead. */
function Mark() {
	return (
		<svg aria-hidden viewBox="0 0 100 100" width="56" height="56" className="-ml-1">
			<path
				d="M29.49 64.15A28.3 28.3 0 1 0 29.49 35.85"
				fill="none"
				stroke="#F6821F"
				strokeWidth="15"
				strokeLinecap="round"
			/>
			<path
				d="M45.08 44.85 13.9 26.85 20.49 51.44Z"
				fill="#F6821F"
				stroke="#F6821F"
				strokeWidth="3"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

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
		<main className="flex h-full items-center justify-center bg-kumo-canvas px-5 pb-20">
			<form onSubmit={(event) => void submit(event)} className="flex w-full max-w-[420px] flex-col">
				<Mark />
				<h1 className="pt-7 text-[28px] leading-[34px] font-bold tracking-[-0.02em] text-kumo-strong md:text-[34px] md:leading-[42px] md:tracking-[-0.025em]">
					Sign in to Loopback
				</h1>
				<p className="pt-2.5 text-[17px] leading-[27px] text-(--loopback-body)">
					Paste the token this deployment was set up with.
				</p>
				<div className="pt-8">
					<Input
						label="Token"
						type="password"
						autoComplete="current-password"
						size="lg"
						value={token}
						onChange={(event) => setDraft(event.target.value)}
						{...(error === null ? {} : { error })}
					/>
				</div>
				<Button
					type="submit"
					variant="primary"
					data-primary=""
					size="lg"
					loading={busy}
					disabled={token.trim() === ""}
					className="mt-5 h-12 w-full justify-center text-[17px]"
				>
					Sign in
				</Button>
				<p className="pt-5 text-[15px] leading-[22px] text-kumo-subtle">
					It's the LOOPBACK_TOKEN you set when you deployed. It stays in this browser.
				</p>
			</form>
		</main>
	);
}
