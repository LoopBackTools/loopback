/**
 * How often a client should poll a background task, by the task's age: under 2 minutes, under 30
 * minutes, and after. Briskly while a quick answer is likely, then less often, since each poll is a
 * request to the space.
 */
export type PollIntervals = readonly [number, number, number];

export const POLL_INTERVALS: PollIntervals = [2_000, 10_000, 30_000];

/** How long a poll should wait before the next: the most a reply waits before the agent sees it. */
export const pollEvery = (
	startedAt: string,
	now: number,
	intervals: PollIntervals = POLL_INTERVALS,
): number => {
	const age = now - Date.parse(startedAt);
	return age < 2 * 60_000 ? intervals[0] : age < 30 * 60_000 ? intervals[1] : intervals[2];
};

/** How long after its next poll is due a task still shows its agent following: room for it to be late. */
export const FOLLOW_SLACK_MS = 10_000;
