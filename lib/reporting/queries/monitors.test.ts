import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { selectRecentRollupWindow } from "./monitors";

describe("selectRecentRollupWindow", () => {
  const rowAt = (iso: string) => ({ bucketStart: new Date(iso) });

  it("includes a row exactly at the cutoff and excludes one just before it", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-17T23:59:59.999Z"),
      rowAt("2026-07-18T00:00:00.000Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result).toEqual([rowAt("2026-07-18T00:00:00.000Z")]);
  });

  it("excludes a row exactly at the end and includes one just before it", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-18T23:59:59.999Z"),
      rowAt("2026-07-19T00:00:00.000Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result).toEqual([rowAt("2026-07-18T23:59:59.999Z")]);
  });

  it("preserves ascending order from the superset without resorting", () => {
    const cutoff = new Date("2026-07-11T00:00:00Z").getTime();
    const end = new Date("2026-07-18T00:00:00Z").getTime();
    const rows = [
      rowAt("2026-07-10T00:00:00Z"),
      rowAt("2026-07-12T00:00:00Z"),
      rowAt("2026-07-14T00:00:00Z"),
      rowAt("2026-07-16T00:00:00Z"),
    ];

    const result = selectRecentRollupWindow(rows, cutoff, end);

    expect(result.map((row) => row.bucketStart.toISOString())).toEqual([
      "2026-07-12T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    ]);
  });

  it("returns an empty array when nothing falls in the window", () => {
    const cutoff = new Date("2026-07-18T00:00:00Z").getTime();
    const end = new Date("2026-07-19T00:00:00Z").getTime();

    expect(selectRecentRollupWindow([rowAt("2026-07-10T00:00:00Z")], cutoff, end)).toEqual([]);
  });
});
