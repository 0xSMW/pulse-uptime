// Polling policy for the live monitor summary. The cadence, the error backoff,
// and the staleness threshold are pure functions so the client hook stays thin
// and the behavior is unit tested without a browser.

import type { MonitorState } from "@/components/monitors/status-dot";
import type { MonitorPhase } from "./queries/first-run";

// Steady monitors refresh every 30 seconds. A monitor mid-setup, verifying, or
// down refreshes on the attentive cadence, well within the 10 to 15 second band.
export const LIVE_POLL_STEADY_MS = 30_000;
export const LIVE_POLL_ATTENTIVE_MS = 12_000;

// States that change often enough to warrant the faster cadence. PENDING covers
// a monitor still waiting on its first result.
const ATTENTIVE_STATES: ReadonlySet<MonitorState> = new Set([
  "PENDING",
  "DOWN",
  "VERIFYING_DOWN",
  "VERIFYING_UP",
]);

export function livePollIntervalMs(input: { phase: MonitorPhase; state: MonitorState }): number {
  if (input.phase === "setup") return LIVE_POLL_ATTENTIVE_MS;
  return ATTENTIVE_STATES.has(input.state) ? LIVE_POLL_ATTENTIVE_MS : LIVE_POLL_STEADY_MS;
}

// Exponential backoff for retries after consecutive failures. It doubles from
// the start delay up to the cap so a flapping endpoint is not hammered.
export const LIVE_BACKOFF_START_MS = 5_000;
export const LIVE_BACKOFF_MAX_MS = 60_000;
export const LIVE_STALE_AFTER_ERRORS = 3;

export function livePollBackoffMs(errorCount: number): number {
  if (errorCount <= 0) return LIVE_BACKOFF_START_MS;
  const delay = LIVE_BACKOFF_START_MS * 2 ** (errorCount - 1);
  return Math.min(delay, LIVE_BACKOFF_MAX_MS);
}

// Data is treated as stale once refreshes fail this many times in a row.
export function livePollIsStale(errorCount: number): boolean {
  return errorCount >= LIVE_STALE_AFTER_ERRORS;
}

// Compact "Updated Ns ago" label. Seconds up to a minute, then whole minutes.
export function formatUpdatedAgo(secondsAgo: number): string {
  const clamped = Math.max(0, Math.floor(secondsAgo));
  if (clamped < 60) return `Updated ${clamped}s ago`;
  return `Updated ${Math.floor(clamped / 60)}m ago`;
}
