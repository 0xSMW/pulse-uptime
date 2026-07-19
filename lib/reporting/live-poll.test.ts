import { describe, expect, it } from "vitest";

import {
  formatUpdatedAgo,
  LIVE_BACKOFF_MAX_MS,
  LIVE_BACKOFF_START_MS,
  LIVE_POLL_ATTENTIVE_MS,
  LIVE_POLL_STEADY_MS,
  livePollBackoffMs,
  livePollIntervalMs,
  livePollIsStale,
} from "./live-poll";

describe("livePollIntervalMs", () => {
  it("polls a steady active monitor on the slow cadence", () => {
    expect(livePollIntervalMs({ phase: "active", state: "UP" })).toBe(LIVE_POLL_STEADY_MS);
    expect(livePollIntervalMs({ phase: "collecting", state: "UP" })).toBe(LIVE_POLL_STEADY_MS);
    expect(livePollIntervalMs({ phase: "active", state: "PAUSED" })).toBe(LIVE_POLL_STEADY_MS);
  });

  it("polls faster while in setup regardless of state", () => {
    expect(livePollIntervalMs({ phase: "setup", state: "PENDING" })).toBe(LIVE_POLL_ATTENTIVE_MS);
    expect(livePollIntervalMs({ phase: "setup", state: "UP" })).toBe(LIVE_POLL_ATTENTIVE_MS);
  });

  it("polls faster while verifying or down", () => {
    expect(livePollIntervalMs({ phase: "active", state: "DOWN" })).toBe(LIVE_POLL_ATTENTIVE_MS);
    expect(livePollIntervalMs({ phase: "active", state: "VERIFYING_DOWN" })).toBe(LIVE_POLL_ATTENTIVE_MS);
    expect(livePollIntervalMs({ phase: "active", state: "VERIFYING_UP" })).toBe(LIVE_POLL_ATTENTIVE_MS);
    expect(livePollIntervalMs({ phase: "collecting", state: "PENDING" })).toBe(LIVE_POLL_ATTENTIVE_MS);
  });

  it("keeps the attentive cadence within the ten to fifteen second band", () => {
    expect(LIVE_POLL_ATTENTIVE_MS).toBeGreaterThanOrEqual(10_000);
    expect(LIVE_POLL_ATTENTIVE_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("livePollBackoffMs", () => {
  it("starts at the base delay", () => {
    expect(livePollBackoffMs(0)).toBe(LIVE_BACKOFF_START_MS);
    expect(livePollBackoffMs(1)).toBe(LIVE_BACKOFF_START_MS);
  });

  it("doubles with each further failure", () => {
    expect(livePollBackoffMs(2)).toBe(LIVE_BACKOFF_START_MS * 2);
    expect(livePollBackoffMs(3)).toBe(LIVE_BACKOFF_START_MS * 4);
  });

  it("caps at the maximum delay", () => {
    expect(livePollBackoffMs(50)).toBe(LIVE_BACKOFF_MAX_MS);
    expect(livePollBackoffMs(2_000)).toBe(LIVE_BACKOFF_MAX_MS);
  });
});

describe("livePollIsStale", () => {
  it("is not stale before three consecutive failures", () => {
    expect(livePollIsStale(0)).toBe(false);
    expect(livePollIsStale(2)).toBe(false);
  });

  it("is stale once failures reach the threshold", () => {
    expect(livePollIsStale(3)).toBe(true);
    expect(livePollIsStale(9)).toBe(true);
  });
});

describe("formatUpdatedAgo", () => {
  it("counts seconds under a minute", () => {
    expect(formatUpdatedAgo(0)).toBe("Updated 0s ago");
    expect(formatUpdatedAgo(12)).toBe("Updated 12s ago");
    expect(formatUpdatedAgo(59.6)).toBe("Updated 59s ago");
  });

  it("counts whole minutes past a minute", () => {
    expect(formatUpdatedAgo(60)).toBe("Updated 1m ago");
    expect(formatUpdatedAgo(185)).toBe("Updated 3m ago");
  });

  it("never shows a negative age", () => {
    expect(formatUpdatedAgo(-5)).toBe("Updated 0s ago");
  });
});
