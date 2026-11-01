import { Banner } from "@cloudflare/kumo";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useEffect } from "react";
import { useUpdate } from "./context.tsx";
import { reloadPage } from "./page.ts";

/**
 * Says when Loopback has been updated under the page. A later deploy of the same revision of the
 * contract is offered as a reload. A later revision is one this page can't fully read, so it reloads
 * at the first moment that disturbs no one: as soon as the page is hidden, or at once if it already
 * is. What the person has written and not sent is kept in this browser, so the reload loses none of it.
 */
export function UpdateBanner() {
	const update = useUpdate();
	useEffect(() => {
		if (update !== "required") return undefined;
		const whenHidden = () => {
			if (document.visibilityState === "hidden") reloadPage();
		};
		whenHidden();
		document.addEventListener("visibilitychange", whenHidden);
		return () => document.removeEventListener("visibilitychange", whenHidden);
	}, [update]);
	if (update === "none") return null;
	return (
		<Banner
			size="sm"
			className="m-2"
			icon={<ArrowClockwise />}
			title="Loopback has been updated"
			description={
				update === "required"
					? "This page reloads onto the new version when you next leave it. Anything you haven't sent is kept."
					: "Reload to use the new version."
			}
			action={<Banner.Action onClick={reloadPage}>Reload</Banner.Action>}
		/>
	);
}
