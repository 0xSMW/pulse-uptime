import { runInNewContext } from "node:vm"

import { beforeEach, describe, expect, it, vi } from "vitest"

const { unsafe } = vi.hoisted(() => ({ unsafe: vi.fn() }))

vi.mock("@/lib/db/client", () => ({ sql: { unsafe } }))
vi.mock("server-only", () => ({}))

import { databaseHealthRepository } from "./repository"

const snapshot = {
  captured_at: "2026-07-18T00:00:00.000Z",
  storage_bytes: "120000000",
  index_bytes: "14000000",
  category_bytes: JSON.stringify({
    recentCheckBatches: 3_000_000,
    coreData: 8_000_000,
    indexes: 14_000_000,
    other: 4_000_000,
  }),
  history_bytes: "4000000",
  monthly_transfer_bytes: "420000000",
  projected_30_day_bytes: "146000000",
  governor_mode: "compact_early",
  last_compaction_at: "2026-07-18T03:17:00.000Z",
  scheduler_coverage: "0.9999",
  provider_metrics_captured_at: "2026-07-18T00:00:00.000Z",
  maintenance_status: "completed",
}

describe("database health repository", () => {
  beforeEach(() => unsafe.mockReset())

  it("normalizes the latest snapshot and retention ages", async () => {
    unsafe.mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([
      {
        key: "minute",
        label: "Recent checks",
        configured_seconds: 172_800,
        oldest_at: null,
      },
    ])
    const result = await databaseHealthRepository.readLatest()
    expect(result).toMatchObject({
      capturedAt: new Date("2026-07-18T00:00:00.000Z"),
      storageBytes: 124_000_000,
      otherBytes: 4_000_000,
      projected30DayBytes: 150_000_000,
      categoryBytes: {
        recentCheckBatches: 3_000_000,
        coreData: 8_000_000,
        indexes: 14_000_000,
      },
      governorMode: "EARLY_COMPACTION",
      schedulerCoverage: 0.9999,
      providerMetricsAvailable: true,
      providerMetricsCapturedAt: new Date("2026-07-18T00:00:00.000Z"),
      maintenanceHealthy: true,
    })
  })

  it("captures allocation in Postgres before reading the stored snapshot", async () => {
    unsafe
      .mockResolvedValueOnce([{ governor_mode: "full" }])
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValueOnce([])
    await expect(databaseHealthRepository.capture()).resolves.toMatchObject({
      capturedAt: new Date(snapshot.captured_at),
    })
    expect(unsafe).toHaveBeenCalledTimes(3)
    expect(String(unsafe.mock.calls[0]![0])).toContain("pg_total_relation_size")
    expect(unsafe.mock.calls[0]![1]![0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("treats running maintenance as unknown and applies effective retention", async () => {
    unsafe
      .mockResolvedValueOnce([
        {
          ...snapshot,
          governor_mode: "shortened",
          maintenance_status: "running",
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "minute",
          label: "Recent checks",
          configured_seconds: 172_800,
          oldest_at: "2026-07-17T00:00:00.000Z",
        },
        {
          key: "15m",
          label: "15-minute rollups",
          configured_seconds: 604_800,
          oldest_at: null,
        },
      ])
    const result = await databaseHealthRepository.readLatest()
    expect(result?.maintenanceHealthy).toBeNull()
    expect(
      result?.retention.map(({ configuredSeconds }) => configuredSeconds)
    ).toEqual([86_400, 259_200])
  })

  it("short-circuits on a cold start without querying retention ages", async () => {
    unsafe.mockResolvedValueOnce([])
    await expect(databaseHealthRepository.readLatest()).resolves.toBeNull()
    // A missing snapshot skips the retention query.
    expect(unsafe).toHaveBeenCalledTimes(1)
  })

  it("rejects an invalid persisted capture timestamp", async () => {
    unsafe.mockResolvedValueOnce([{ ...snapshot, captured_at: "not-a-date" }])
    await expect(databaseHealthRepository.readLatest()).rejects.toThrow(
      "Invalid database usage snapshot timestamp"
    )
    // An invalid timestamp skips the retention query.
    expect(unsafe).toHaveBeenCalledTimes(1)
  })

  it("normalizes timestamps created by another runtime realm", async () => {
    const foreignDate = runInNewContext(
      "new Date('2026-07-18T04:00:00.000Z')"
    ) as Date
    expect(foreignDate).not.toBeInstanceOf(Date)
    unsafe
      .mockResolvedValueOnce([
        {
          ...snapshot,
          captured_at: foreignDate,
          provider_metrics_captured_at: foreignDate,
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "minute",
          label: "Recent checks",
          configured_seconds: 172_800,
          oldest_at: foreignDate,
        },
      ])
    const result = await databaseHealthRepository.readLatest()
    expect(result?.capturedAt.toISOString()).toBe("2026-07-18T04:00:00.000Z")
    expect(result?.retention[0]?.oldestAt?.toISOString()).toBe(
      "2026-07-18T04:00:00.000Z"
    )
  })
})
