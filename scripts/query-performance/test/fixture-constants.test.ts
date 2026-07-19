import { describe, expect, it } from "vitest";

import { isFixtureMonitorId, monitorId, MONITOR_COUNT } from "../src/fixture-constants";

describe("monitorId", () => {
  it("produces a stable, zero-padded, tagged id", () => {
    expect(monitorId(1)).toBe("qh-monitor-0001");
    expect(monitorId(100)).toBe("qh-monitor-0100");
  });

  it("round-trips through isFixtureMonitorId", () => {
    for (let index = 1; index <= MONITOR_COUNT; index += 1) {
      expect(isFixtureMonitorId(monitorId(index))).toBe(true);
    }
  });

  it("rejects ids outside the fixture tag", () => {
    expect(isFixtureMonitorId("prod-monitor-0001")).toBe(false);
    expect(isFixtureMonitorId("")).toBe(false);
  });
});
