import { beforeEach, describe, expect, it, vi } from "vitest";

const { unsafe } = vi.hoisted(() => ({ unsafe: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ sql: { unsafe } }));
vi.mock("server-only", () => ({}));

import { databaseHealthRepository } from "./repository";

const snapshot = {
  captured_at: new Date("2026-07-18T00:00:00Z"),
  storage_bytes: "120000000",
  category_bytes: { recentCheckBatches: 3_000_000, coreData: 8_000_000, indexes: 14_000_000, other: 4_000_000 },
  monthly_transfer_bytes: "420000000",
  projected_30_day_bytes: "146000000",
  governor_mode: "compact_early",
  last_compaction_at: new Date("2026-07-18T03:17:00Z"),
  scheduler_coverage: "0.9999",
  provider_metrics_captured_at: new Date("2026-07-18T00:00:00Z"),
  maintenance_status: "completed",
};

describe("database health repository", () => {
  beforeEach(() => unsafe.mockReset());

  it("normalizes the latest snapshot and retention ages", async () => {
    unsafe
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValueOnce([{ key: "minute", label: "Recent checks", configured_seconds: 172800, oldest_at: null }]);
    const result = await databaseHealthRepository.readLatest();
    expect(result).toMatchObject({
      storageBytes: 120_000_000,
      projected30DayBytes: 146_000_000,
      categoryBytes: { recentCheckBatches: 3_000_000, coreData: 8_000_000, indexes: 14_000_000 },
      governorMode: "EARLY_COMPACTION",
      schedulerCoverage: 0.9999,
      providerMetricsAvailable: true,
      maintenanceHealthy: true,
    });
  });

  it("captures allocation in Postgres before reading the stored snapshot", async () => {
    unsafe
      .mockResolvedValueOnce([{ governor_mode: "full" }])
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValueOnce([]);
    await expect(databaseHealthRepository.capture()).resolves.toMatchObject({ capturedAt: snapshot.captured_at });
    expect(unsafe).toHaveBeenCalledTimes(3);
    expect(String(unsafe.mock.calls[0]![0])).toContain("pg_total_relation_size");
  });
});
