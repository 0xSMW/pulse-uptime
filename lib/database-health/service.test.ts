import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  clearDatabaseHealthCache,
  deriveDatabaseHealthState,
  presentDatabaseHealth,
  refreshDatabaseHealth,
} from "./service"
import {
  DATABASE_STORAGE_BUDGET_BYTES,
  type DatabaseHealthMeasurement,
  type DatabaseHealthRepository,
} from "./types"

const now = new Date("2026-07-18T12:00:00.000Z")

function measurement(
  overrides: Partial<DatabaseHealthMeasurement> = {}
): DatabaseHealthMeasurement {
  return {
    capturedAt: new Date("2026-07-18T11:55:00.000Z"),
    storageBytes: 118_000_000,
    otherBytes: 4_000_000,
    projected30DayBytes: 146_000_000,
    categoryBytes: {
      recentCheckBatches: 3_000_000,
      rollups: 62_000_000,
      exceptions: 18_000_000,
      incidents: 9_000_000,
      coreData: 8_000_000,
      operations: 0,
      indexes: 14_000_000,
    },
    retention: [
      {
        key: "recent",
        label: "Recent checks",
        configuredSeconds: 172_800,
        oldestAt: new Date("2026-07-17T05:00:00.000Z"),
      },
    ],
    governorMode: "FULL_DETAIL",
    governorAction: null,
    lastCompactionAt: new Date("2026-07-18T03:17:00.000Z"),
    schedulerCoverage: 0.9999,
    monthlyTransferBytes: 420_000_000,
    projectedMonthlyTransferBytes: 690_000_000,
    providerMetricsAvailable: true,
    providerMetricsCapturedAt: new Date("2026-07-18T11:54:00.000Z"),
    maintenanceHealthy: true,
    ...overrides,
  }
}

describe("database health state", () => {
  it.each([
    [0.599, "HEALTHY"],
    [0.6, "WATCHING"],
    [0.75, "OPTIMIZING"],
    [0.85, "PROTECTING"],
    [0.95, "PROTECTING"],
    [0.950_001, "CRITICAL"],
  ] as const)("maps projected utilization %s to %s", (utilization, expected) => {
    expect(
      deriveDatabaseHealthState(
        measurement({
          projected30DayBytes: DATABASE_STORAGE_BUDGET_BYTES * utilization,
        }),
        now
      )
    ).toBe(expected)
  })

  it("prioritizes failed maintenance over stale metrics", () => {
    expect(
      deriveDatabaseHealthState(
        measurement({
          capturedAt: new Date("2026-07-01T00:00:00.000Z"),
          maintenanceHealthy: false,
        }),
        now
      )
    ).toBe("CRITICAL")
  })

  it.each([
    { maintenanceHealthy: null },
    { capturedAt: new Date("2026-07-16T00:00:00.000Z") },
    { projected30DayBytes: null },
  ])("uses Unknown for unavailable or stale metrics", (override) => {
    expect(deriveDatabaseHealthState(measurement(override), now)).toBe(
      "UNKNOWN"
    )
  })

  it("derives health from relation metrics when provider metrics are absent", () => {
    expect(
      deriveDatabaseHealthState(
        measurement({
          providerMetricsAvailable: false,
          providerMetricsCapturedAt: null,
        }),
        now
      )
    ).toBe("HEALTHY")
  })
})

describe("database health presentation", () => {
  it("attributes provider-only bytes to Other and exposes budget safety", () => {
    const report = presentDatabaseHealth(measurement(), { now })
    expect(report.categories.map(({ key }) => key)).toEqual([
      "recentCheckBatches",
      "rollups",
      "exceptions",
      "incidents",
      "coreData",
      "operations",
      "content",
      "indexes",
      "other",
    ])
    expect(
      report.categories.find(({ key }) => key === "content")
    ).toMatchObject({ label: "Images & reports" })
    expect(report.categories.at(-1)).toMatchObject({
      key: "other",
      bytes: 4_000_000,
    })
    expect(report.availableBytes).toBe(382_000_000)
    expect(report.governor.action).toBe("Full configured detail is retained")
    expect(report.schedulerCoverage).toBe(0.9999)
  })

  it("clamps Other when attributed relations exceed provider storage", () => {
    const report = presentDatabaseHealth(
      measurement({ storageBytes: 1, otherBytes: null }),
      { now }
    )
    expect(report.categories.at(-1)?.bytes).toBe(0)
  })
})

describe("database health refresh", () => {
  it("uses the persisted capture time as the 15-minute gate", async () => {
    const latest = measurement({
      capturedAt: new Date("2026-07-18T11:45:00.001Z"),
    })
    const repository: DatabaseHealthRepository = {
      readLatest: vi.fn().mockResolvedValue(latest),
      capture: vi.fn().mockResolvedValue(measurement({ capturedAt: now })),
    }
    clearDatabaseHealthCache(repository)
    const cached = await refreshDatabaseHealth(repository, now)
    expect(cached.refresh.cached).toBe(true)
    expect(cached.refresh.status).toBe("CACHED")
    expect(repository.capture).not.toHaveBeenCalled()

    latest.capturedAt = new Date("2026-07-18T11:45:00.000Z")
    clearDatabaseHealthCache(repository)
    const refreshed = await refreshDatabaseHealth(repository, now)
    expect(refreshed.refresh.cached).toBe(false)
    expect(repository.capture).toHaveBeenCalledOnce()
  })

  it("returns the prior snapshot when capture throws", async () => {
    const latest = measurement({
      capturedAt: new Date("2026-07-18T11:00:00.000Z"),
    })
    const repository: DatabaseHealthRepository = {
      readLatest: vi.fn().mockResolvedValue(latest),
      capture: vi.fn().mockRejectedValue(new Error("secret provider failure")),
    }
    const result = await refreshDatabaseHealth(repository, now)
    expect(result.refresh).toMatchObject({
      cached: false,
      status: "STALE_FALLBACK",
    })
    expect(JSON.stringify(result)).not.toContain("secret provider failure")
  })

  it("coalesces concurrent capture work in one runtime", async () => {
    let resolveCapture!: (value: DatabaseHealthMeasurement) => void
    const captureResult = new Promise<DatabaseHealthMeasurement>((resolve) => {
      resolveCapture = resolve
    })
    const repository: DatabaseHealthRepository = {
      readLatest: vi.fn().mockResolvedValue(null),
      capture: vi.fn().mockReturnValue(captureResult),
    }
    const first = refreshDatabaseHealth(repository, now)
    const second = refreshDatabaseHealth(repository, now)
    resolveCapture(measurement({ capturedAt: now }))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(repository.capture).toHaveBeenCalledOnce()
  })
})
