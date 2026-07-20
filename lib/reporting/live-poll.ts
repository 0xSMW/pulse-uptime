// Polling policy for the live monitor summary. The cadence, the error backoff,
// and the staleness threshold are pure functions so the client hook stays thin
// and the behavior is unit tested without a browser.

import type { MonitorState } from "@/lib/monitoring/types";
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

// Statuses that no retry can recover. A 404 means the monitor was archived or
// deleted in another session. A 401 or 403 means the session expired or lost
// access while the page stayed open. The poll stops retrying and the client
// refreshes once so the server layout redirects to login or the server
// component resolves to its not-found path.
const LIVE_TERMINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

export function livePollIsTerminal(status: number | undefined): boolean {
  return status !== undefined && LIVE_TERMINAL_STATUSES.has(status);
}

// The live poll recomputes only the h24 and d7 scores, yet its unlock flags span
// all four ranges. A page held open across the 30 or 90 day activation boundary
// sees d30 or d90 flip to unlocked with no matching score in the payload. The
// client keeps the snapshot flags and refreshes once so the server recomputes
// the full range and its score. Returns true when either long range unlocks past
// the snapshot, which also advances a paused monitor whose rollup version never
// moves.
export function livePollUnlockAdvanced(
  snapshot: { d30: boolean; d90: boolean },
  live: { d30: boolean; d90: boolean },
): boolean {
  return (live.d30 && !snapshot.d30) || (live.d90 && !snapshot.d90);
}

// A config edit from any session accepts a new snapshot, advancing its
// acceptedAt. The live poll carries that opaque change token while the page holds
// the config fields from the server snapshot. A paused monitor produces no new
// rollup, so this is the only signal that lands an out-of-band name, url,
// threshold, or recipient edit on the open page. Returns true when the live token
// is present and differs from the snapshot, so the client refreshes once to pull
// the edit.
export function livePollConfigChanged(
  snapshotToken: string | null,
  liveToken: string | null,
): boolean {
  return liveToken !== null && liveToken !== snapshotToken;
}

// The completed 15-minute window boundary the live poll recomputes h24 and d7
// against. It advances every 15 minutes even on a paused monitor whose rollup
// version never moves, so the server-pinned timeline and response chart drift
// from the live score as old buckets age out of the sliding window. The client
// holds the snapshot boundary and refreshes once when the poll carries a later
// one, so the server recomputes the charts against the current window. It moves
// every 15 minutes, not every poll, so this drives one refresh per boundary.
// Returns true when the live boundary is present and differs from the snapshot.
export function livePollWindowAdvanced(
  snapshotVersion: string | null,
  liveVersion: string | null,
): boolean {
  return liveVersion !== null && liveVersion !== snapshotVersion;
}

// Compact "Updated Ns ago" label. Seconds up to a minute, then whole minutes.
export function formatUpdatedAgo(secondsAgo: number): string {
  const clamped = Math.max(0, Math.floor(secondsAgo));
  if (clamped < 60) return `Updated ${clamped}s ago`;
  return `Updated ${Math.floor(clamped / 60)}m ago`;
}
