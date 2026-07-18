import { describe, expect, it } from "vitest";

import { buildCheckTimeline, buildDailyTimeline, statusGroupSlug } from "./timeline";

describe("buildCheckTimeline", () => {
  it("creates a fixed number of chronological buckets", () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const timeline = buildCheckTimeline([
      { checkedAt: new Date("2026-07-18T11:50:00Z"), successful: false },
      { checkedAt: new Date("2026-07-18T11:55:00Z"), successful: true },
    ], 6, 60 * 60 * 1_000, now);

    expect(timeline).toHaveLength(6);
    expect(timeline.at(-1)?.state).toBe("verifying");
  });
});

describe("buildDailyTimeline", () => {
  it("fills missing days and classifies daily availability", () => {
    const timeline = buildDailyTimeline([
      { day: "2026-07-16", totalChecks: 10, failedChecks: 0, incidentSeconds: 0 },
      { day: "2026-07-18", totalChecks: 10, failedChecks: 2, incidentSeconds: 80 },
    ], 3, new Date("2026-07-18T12:00:00Z"));

    expect(timeline.map(({ state }) => state)).toEqual(["up", "no-data", "verifying"]);
    expect(timeline[2]?.downtimeSeconds).toBe(80);
  });
});

describe("statusGroupSlug", () => {
  it("creates stable, URL-safe group slugs", () => {
    expect(statusGroupSlug("Primary APIs")).toBe("primary-apis");
    expect(statusGroupSlug("  Édge / EU  ")).toBe("edge-eu");
    expect(statusGroupSlug("服務")).toBe("other");
  });
});
