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

  describe("scalar affected-count parsing", () => {
    it.each([0, 1, 10_000])("returns %i exactly from a single scalar row", async (affected) => {
      const query = vi.fn().mockResolvedValue([{ affected }]);
      const result = await createSqlMaintenanceStore({ query }).deleteRawChecks(new Date("2026-06-18T00:00:00Z"), 20_000);
      expect(result).toBe(affected);
    });

    it("treats a missing row as zero affected", async () => {
      const query = vi.fn().mockResolvedValue([]);
      const result = await createSqlMaintenanceStore({ query }).deleteSentNotifications(new Date("2026-06-18T00:00:00Z"), 10_000);
      expect(result).toBe(0);
    });

    it("returns the exact telemetry batch sum at 19999", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 19_999 }]);
      const result = await createSqlMaintenanceStore({ query }).enforceTelemetryRetention(
        new Date("2026-07-18T12:00:00Z"), "incident_only", 10_000,
      );
      expect(result).toBe(19_999);
    });

    it("returns the exact telemetry batch sum at the 2x limit ceiling of 20000", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 20_000 }]);
      const result = await createSqlMaintenanceStore({ query }).enforceTelemetryRetention(
        new Date("2026-07-18T12:00:00Z"), "incident_only", 10_000,
      );
      expect(result).toBe(20_000);
    });
  });

  describe("count-only DML shape", () => {
    it("returns a single scalar row per statement instead of one row per affected key", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 3 }]);
      await createSqlMaintenanceStore({ query }).deleteRawChecks(new Date("2026-06-18T00:00:00Z"), 5);
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain("returning 1");
      expect(sql).toMatch(/select count\(\*\)::int as affected from \w+$/);
      expect(sql).not.toMatch(/returning [\w.]+\.id\b/);
    });

    it("preserves the selection predicate, order, and limit ahead of the delete", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 0 }]);
      await createSqlMaintenanceStore({ query }).deleteRawChecks(new Date("2026-06-18T00:00:00Z"), 5);
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain("where created_at < $1 order by created_at, id limit $2");
      expect(sql).toContain("delete from check_results using doomed where check_results.id = doomed.id");
    });

    it("keeps the reconcile-cron update predicate and turns its RETURNING into a scalar count", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 0 }]);
      await createSqlMaintenanceStore({ query }).reconcileStaleCronRuns(new Date("2026-07-18T04:00:00Z"));
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain("where status = 'running' and started_at < $2");
      expect(sql).toContain("returning 1");
      expect(sql).toMatch(/select count\(\*\)::int as affected from changed$/);
    });

    it("keeps both bounded telemetry branches independent and sums their scalar counts", async () => {
      const query = vi.fn().mockResolvedValue([{ affected: 0 }]);
      await createSqlMaintenanceStore({ query }).enforceTelemetryRetention(
        new Date("2026-07-18T12:00:00Z"), "incident_only", 10_000,
      );
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain("deleted_batches as (\n  delete from check_batches using doomed where check_batches.scheduled_minute = doomed.scheduled_minute\n  returning 1\n)");
      expect(sql).toContain("deleted_rollups as (");
      expect(sql.match(/returning 1/g)).toHaveLength(2);
      expect(sql).toContain(
        "select (select count(*)::int from deleted_batches) + (select count(*)::int from deleted_rollups) as affected",
      );
    });
  });
});
