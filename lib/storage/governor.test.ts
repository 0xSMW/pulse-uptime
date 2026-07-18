import { describe, expect, it } from "vitest";

import { governorMode, retentionFor } from "./governor";

describe("adaptive storage governor", () => {
  it.each([
    [0n, "full"], [599n, "full"], [600n, "compact_early"],
    [749n, "compact_early"], [750n, "shortened"], [849n, "shortened"],
    [850n, "incident_only"], [950n, "incident_only"], [951n, "essential"],
  ] as const)("classifies %s at exact thresholds", (projected, expected) => {
    expect(governorMode(projected, 1_000n)).toBe(expected);
  });

  it("only tightens lower-value detail while preserving daily uptime", () => {
    const policies = ["full", "compact_early", "shortened", "incident_only", "essential"]
      .map((mode) => retentionFor(mode as Parameters<typeof retentionFor>[0]));
    expect(policies.map((policy) => policy.minuteHours)).toEqual([48, 36, 24, 12, 0]);
    expect(policies.every((policy) => policy.preserveDaily)).toBe(true);
  });
});
