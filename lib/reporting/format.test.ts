import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatLatency,
  formatRelativeTime,
  formatUptimeDetail,
  formatUptimeTable,
} from "./format";

describe("report formatting", () => {
  it("formats uptime for tables and details", () => {
    expect(formatUptimeTable(100)).toBe("100.00%");
    expect(formatUptimeDetail(99.93064)).toBe("99.9306%");
    expect(formatUptimeDetail(98.123)).toBe("98.12%");
    expect(formatUptimeTable(null)).toBe("—");
  });

  it("formats latency and compact durations", () => {
    expect(formatLatency(141.7)).toBe("142 ms");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(1_084)).toBe("18m 4s");
    expect(formatDuration(4_320)).toBe("1h 12m");
    expect(formatDuration(187_200)).toBe("2d 4h");
  });

  it("formats relative and UTC times", () => {
    const now = new Date("2026-07-18T14:03:30.000Z");
    expect(formatRelativeTime(new Date("2026-07-18T14:03:18.000Z"), now)).toBe("12s ago");
    expect(formatRelativeTime(new Date("2026-07-18T13:45:00.000Z"), now)).toBe("18m ago");
    expect(formatRelativeTime(new Date("2026-07-17T14:03:00.000Z"), now)).toBe("Jul 17, 14:03");
  });
});
