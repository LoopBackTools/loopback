/**
 * The Workers plan to deploy for, from `LOOPBACK_PLAN` at deploy time: Paid when it says `paid`,
 * written any way; Free otherwise, unset included.
 */
export const planFrom = (value: string | undefined): "free" | "paid" =>
	value?.trim().toLowerCase() === "paid" ? "paid" : "free";

/**
 * What a deploy that falls back to Free prints. The plan is read at every deploy, so a Paid
 * deployment deployed again without `LOOPBACK_PLAN=paid` would otherwise switch to Free unseen.
 */
export const planNotice = (value: string | undefined): string | undefined => {
	if (planFrom(value) === "paid") return undefined;
	const why =
		value === undefined || value.trim() === ""
			? "LOOPBACK_PLAN is not set"
			: `LOOPBACK_PLAN is "${value}"`;
	return `Deploying Loopback for Workers Free (${why}): a blocking question waits 10 minutes, then asks the agent to call again. On Workers Paid, deploy with LOOPBACK_PLAN=paid every time.`;
};
