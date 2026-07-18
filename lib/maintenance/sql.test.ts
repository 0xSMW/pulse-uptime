import { describe, expect, it, vi } from "vitest";

import { createSqlMaintenanceStore } from "./sql";

describe("maintenance SQL store", () => {
  it("passes the exact retention batch limit to raw-check deletion", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const cutoff = new Date("2026-06-18T00:00:00Z");
    await createSqlMaintenanceStore({ query }).deleteRawChecks(cutoff, 10_000);
    expect(query.mock.calls[0]?.[0]).toContain("limit $2");
    expect(query.mock.calls[0]?.[1]).toEqual([cutoff, 10_000]);
  });

  it("uses shared stale-claim reconciliation with its ambiguity cutoff", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await createSqlMaintenanceStore({ query }).reconcileStaleOutbox(new Date("2026-07-18T04:00:00Z"));
    expect(query.mock.calls[0]?.[1]).toHaveLength(3);
    expect(query.mock.calls[0]?.[0]).toContain("AMBIGUOUS_PROVIDER_RESULT");
  });

  it("keeps actual same-day captures and later downsamples to daily and monthly points", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await createSqlMaintenanceStore({ query }).retainUsageSnapshots(new Date("2026-07-18T12:00:00Z"), 10_000);
    expect(query.mock.calls[0]?.[0]).toContain("daily_point");
    expect(query.mock.calls[0]?.[0]).toContain("monthly_point");
    expect(query.mock.calls[0]?.[0]).toContain("latest_point");
  });

  it("bounds adaptive cleanup while preserving incident detail windows", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await createSqlMaintenanceStore({ query }).enforceTelemetryRetention(
      new Date("2026-07-18T12:00:00Z"), "incident_only", 10_000,
    );
    expect(query.mock.calls[0]?.[0]).toContain("limit $3");
    expect(query.mock.calls[0]?.[0]).toContain("has_incident");
    expect(query.mock.calls[0]?.[1]?.[8]).toBe(true);
    expect(query.mock.calls[0]?.[1]?.[2]).toBe(10_000);
  });
});
