import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { groupByMonitorId } from "./status";

describe("groupByMonitorId", () => {
  it("groups rows by monitor id in one pass, preserving each monitor's relative order", () => {
    const rows = [
      { monitorId: "a", bucketStart: "2026-07-01" },
      { monitorId: "b", bucketStart: "2026-07-01" },
      { monitorId: "a", bucketStart: "2026-07-02" },
      { monitorId: "a", bucketStart: "2026-07-03" },
      { monitorId: "b", bucketStart: "2026-07-02" },
    ];

    const grouped = groupByMonitorId(rows);

    expect(grouped.get("a")).toEqual([
      { monitorId: "a", bucketStart: "2026-07-01" },
      { monitorId: "a", bucketStart: "2026-07-02" },
      { monitorId: "a", bucketStart: "2026-07-03" },
    ]);
    expect(grouped.get("b")).toEqual([
      { monitorId: "b", bucketStart: "2026-07-01" },
      { monitorId: "b", bucketStart: "2026-07-02" },
    ]);
  });

  it("produces the same per-monitor subset as a naive filter would", () => {
    const rows = [
      { monitorId: "a", value: 1 },
      { monitorId: "c", value: 2 },
      { monitorId: "b", value: 3 },
      { monitorId: "a", value: 4 },
      { monitorId: "c", value: 5 },
    ];

    const grouped = groupByMonitorId(rows);

    for (const id of ["a", "b", "c"]) {
      expect(grouped.get(id) ?? []).toEqual(rows.filter((row) => row.monitorId === id));
    }
  });

  it("returns no entry for a monitor with zero matching rows", () => {
    const grouped = groupByMonitorId([{ monitorId: "a", value: 1 }]);

    expect(grouped.get("missing")).toBeUndefined();
    expect(grouped.get("missing") ?? []).toEqual([]);
  });

  it("returns an empty map for an empty input", () => {
    expect(groupByMonitorId([]).size).toBe(0);
  });
});
