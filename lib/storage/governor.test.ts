import { describe, expect, it } from "vitest";

import { GOVERNOR_ACTIONS, GOVERNOR_THRESHOLD_PERCENTS, governorMode, retentionFor } from "./governor";

describe("adaptive storage governor", () => {
  it.each([
    [0n, "full"], [599n, "full"], [600n, "compact_early"],
    [749n, "compact_early"], [750n, "shortened"], [849n, "shortened"],
    [850n, "incident_only"], [950n, "incident_only"], [951n, "essential"],
  ] as const)("classifies %s at exact thresholds", (projected, expected) => {
    expect(governorMode(projected, 1_000n)).toBe(expected);
  });

  it("drives its mode boundaries from the shared threshold percents", () => {
    const p = GOVERNOR_THRESHOLD_PERCENTS;
    expect(governorMode(BigInt(p.compactEarly - 1), 100n)).toBe("full");
    expect(governorMode(BigInt(p.compactEarly), 100n)).toBe("compact_early");
    expect(governorMode(BigInt(p.shortened), 100n)).toBe("shortened");
    expect(governorMode(BigInt(p.incidentOnly), 100n)).toBe("incident_only");
    expect(governorMode(BigInt(p.essential), 100n)).toBe("incident_only");
    expect(governorMode(BigInt(p.essential + 1), 100n)).toBe("essential");
  });

  it("provides declarative action copy for every public mode", () => {
    expect(Object.keys(GOVERNOR_ACTIONS)).toEqual([
      "FULL_DETAIL", "EARLY_COMPACTION", "SHORTENED_RETENTION", "INCIDENT_HOURLY_ONLY", "ESSENTIALS_ONLY", "UNKNOWN",
    ]);
    expect(GOVERNOR_ACTIONS.FULL_DETAIL).toBe("Full configured detail is retained");
  });

  it("only tightens lower-value detail while preserving daily uptime", () => {
    const policies = ["full", "compact_early", "shortened", "incident_only", "essential"]
      .map((mode) => retentionFor(mode as Parameters<typeof retentionFor>[0]));
    expect(policies.map((policy) => policy.minuteHours)).toEqual([48, 36, 24, 12, 0]);
    expect(policies.every((policy) => policy.preserveDaily)).toBe(true);
  });
});
