import { describe, expect, it } from "vitest";

import {
  formatUpdatedAgo,
  LIVE_BACKOFF_MAX_MS,
  LIVE_BACKOFF_START_MS,
  LIVE_POLL_ATTENTIVE_MS,
  LIVE_POLL_STEADY_MS,
  livePollBackoffMs,
  livePollConfigChanged,
  livePollIntervalMs,
  livePollIsStale,
  livePollIsTerminal,
  livePollUnlockAdvanced,
  livePollWindowAdvanced,
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

describe("livePollIsTerminal", () => {
  it("treats a gone monitor and a lost session as terminal so the poll stops retrying", () => {
    expect(livePollIsTerminal(404)).toBe(true);
    expect(livePollIsTerminal(401)).toBe(true);
    expect(livePollIsTerminal(403)).toBe(true);
  });

  it("keeps retrying every other failure, including transient server and network errors", () => {
    expect(livePollIsTerminal(500)).toBe(false);
    expect(livePollIsTerminal(503)).toBe(false);
    expect(livePollIsTerminal(429)).toBe(false);
    expect(livePollIsTerminal(undefined)).toBe(false);
  });
});

describe("livePollUnlockAdvanced", () => {
  it("advances when a long range unlocks past the snapshot", () => {
    expect(
      livePollUnlockAdvanced({ d30: false, d90: false }, { d30: true, d90: false }),
    ).toBe(true);
    expect(
      livePollUnlockAdvanced({ d30: true, d90: false }, { d30: true, d90: true }),
    ).toBe(true);
  });

  it("holds steady when the flags match", () => {
    expect(
      livePollUnlockAdvanced({ d30: false, d90: false }, { d30: false, d90: false }),
    ).toBe(false);
    expect(
      livePollUnlockAdvanced({ d30: true, d90: true }, { d30: true, d90: true }),
    ).toBe(false);
  });

  it("does not advance when the snapshot already leads the poll", () => {
    expect(
      livePollUnlockAdvanced({ d30: true, d90: true }, { d30: false, d90: false }),
    ).toBe(false);
  });
});

describe("livePollConfigChanged", () => {
  it("refreshes once when a config edit advances the accepted snapshot", () => {
    expect(
      livePollConfigChanged("2026-07-19T00:00:00.000Z", "2026-07-19T00:05:00.000Z"),
    ).toBe(true);
  });

  it("lands the first accepted config on a page opened before any snapshot existed", () => {
    expect(livePollConfigChanged(null, "2026-07-19T00:00:00.000Z")).toBe(true);
  });

  it("holds steady while the token matches the snapshot", () => {
    expect(
      livePollConfigChanged("2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z"),
    ).toBe(false);
    expect(livePollConfigChanged(null, null)).toBe(false);
  });

  it("does not refresh when the poll carries no config token yet", () => {
    expect(livePollConfigChanged("2026-07-19T00:00:00.000Z", null)).toBe(false);
  });
});

describe("livePollWindowAdvanced", () => {
  it("refreshes once when the completed window boundary slides forward", () => {
    expect(
      livePollWindowAdvanced("2026-07-19T12:00:00.000Z", "2026-07-19T12:15:00.000Z"),
    ).toBe(true);
  });

  it("holds steady while the boundary matches the snapshot, so it does not refresh every poll", () => {
    expect(
      livePollWindowAdvanced("2026-07-19T12:00:00.000Z", "2026-07-19T12:00:00.000Z"),
    ).toBe(false);
  });

  it("does not refresh when the poll carries no window boundary yet", () => {
    expect(livePollWindowAdvanced("2026-07-19T12:00:00.000Z", null)).toBe(false);
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
