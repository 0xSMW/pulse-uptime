import { describe, expect, it } from "vitest";

import { formatOverlapTiming } from "./dependency-overlap-card";

describe("formatOverlapTiming", () => {
  it("says 'before' when the provider incident started earlier (negative offset)", () => {
    expect(formatOverlapTiming(-180)).toBe("Provider incident began 3 minutes before this outage");
  });

  it("says 'after' when the provider incident started later (positive offset)", () => {
    expect(formatOverlapTiming(300)).toBe("Provider incident began 5 minutes after this outage");
  });

  it("collapses to a same-minute sentence when the offset rounds to zero minutes", () => {
    expect(formatOverlapTiming(0)).toBe("Provider incident began the same minute as this outage");
    expect(formatOverlapTiming(20)).toBe("Provider incident began the same minute as this outage");
    expect(formatOverlapTiming(-25)).toBe("Provider incident began the same minute as this outage");
  });

  it("uses singular 'minute' for exactly one minute either direction", () => {
    expect(formatOverlapTiming(-60)).toBe("Provider incident began 1 minute before this outage");
    expect(formatOverlapTiming(60)).toBe("Provider incident began 1 minute after this outage");
  });

  it("never uses causal language", () => {
    const sentence = formatOverlapTiming(-600);
    expect(sentence).not.toMatch(/root cause|caused by|confirmed cause/i);
  });
});
