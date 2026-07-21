import { describe, expect, it, vi } from "vitest"

import {
  CATALOG_VALIDATION_BUDGET_MS,
  isStatementBudgetError,
  type MaintenanceStore,
  performMaintenance,
  performSweep,
} from "./coordinator"

function baseStore(
  overrides: Partial<MaintenanceStore> = {}
): MaintenanceStore {
  const zero = vi.fn().mockResolvedValue(0)
  return {
    reconcileStaleOutbox: zero,
    reconcileStaleCronRuns: zero,
    deleteRawChecks: zero,
    deleteSentNotifications: zero,
    expireConfigApprovals: zero,
    expireApiIdempotency: zero,
    markDeviceAuthorizationsExpired: zero,
    deleteExpiredDeviceAuthorizations: zero,
    expireRateLimitBuckets: zero,
    retainConfigSnapshots: zero,
    deleteOldCronRuns: zero,
    deleteOldRollups: zero,
    compact15Minute: zero,
    fillSchedulerGaps: zero,
    schedulerCoverageStart: async (now) => now,
    promoteRollups: zero,
    measureAndSnapshotUsage: async () => "full",
    readLatestGovernorMode: async () => "full",
    enforceTelemetryRetention: zero,
    retainUsageSnapshots: zero,
    retainExceptions: zero,
    retainExceptionPayloads: zero,
    deleteOrphanImages: zero,
    reconcileDependencyCatalog: async () => ({
      checkedSources: 0,
      disabledPresets: 0,
    }),
    retainDependencyIncidentUpdates: zero,
    compactDependencyStateIntervals: zero,
    ...overrides,
  }
}

describe("performMaintenance", () => {
  it("reconciles, compacts mergeable rollups, and uses bounded retention batches", async () => {
    const calls: [string, ...unknown[]][] = []
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args])
        return 1
      }
    const measure = async (...args: unknown[]) => {
      calls.push(["measure", ...args])
      return "full" as const
    }
    const now = new Date("2026-07-18T03:15:00Z")
    const summary = await performMaintenance(
      baseStore({
        reconcileStaleOutbox: record("outbox"),
        reconcileStaleCronRuns: record("cron-stale"),
        deleteRawChecks: record("checks"),
        deleteSentNotifications: record("notifications"),
        expireConfigApprovals: record("approvals"),
        expireApiIdempotency: record("idempotency"),
        markDeviceAuthorizationsExpired: record("device-mark"),
        deleteExpiredDeviceAuthorizations: record("device-delete"),
        expireRateLimitBuckets: record("rate"),
        retainConfigSnapshots: record("snapshots"),
        deleteOldCronRuns: record("cron-retention"),
        deleteOldRollups: record("rollup-retention"),
        compact15Minute: record("compact-15m"),
        fillSchedulerGaps: record("fill-gaps"),
        schedulerCoverageStart: async () => now,
        promoteRollups: record("promote"),
        measureAndSnapshotUsage: measure,
        enforceTelemetryRetention: record("telemetry-retention"),
        retainUsageSnapshots: record("usage-retention"),
        retainExceptions: record("exception-retention"),
        retainExceptionPayloads: record("payload-retention"),
        deleteOrphanImages: record("orphan-images"),
        reconcileDependencyCatalog: async (...args: unknown[]) => {
          calls.push(["dependency-catalog", ...args])
          return { checkedSources: 1, disabledPresets: 0 }
        },
        retainDependencyIncidentUpdates: record("dependency-updates"),
        compactDependencyStateIntervals: record("dependency-compact"),
      }),
      now
    )

    expect(calls.find(([name]) => name === "checks")?.[2]).toBe(10_000)
    expect(calls.find(([name]) => name === "snapshots")?.slice(2)).toEqual([
      50,
      10_000,
      expect.any(Number),
    ])
    expect(
      calls.find(([name]) => name === "orphan-images")?.slice(1, 4)
    ).toEqual([new Date("2026-07-17T03:15:00Z"), 20, 10_000])
    expect(summary).toMatchObject({
      staleOutbox: 1,
      staleCronRuns: 1,
      rollups: 3,
      deleted: 12,
      expired: 5,
      governorMode: "full",
      dependencyCatalog: { checkedSources: 1, disabledPresets: 0 },
      deadlineExceeded: false,
    })
    expect(summary.skippedTasks).toEqual([])
    // Catalog revalidation runs once per pass, not batched like the retention deletes.
    expect(
      calls.filter(([name]) => name === "dependency-catalog")
    ).toHaveLength(1)
    expect(calls.find(([name]) => name === "dependency-catalog")?.[1]).toEqual(
      now
    )
    // Retention and compaction cutoffs are exactly two years before now.
    const twoYearsAgo = new Date(now.getTime() - 730 * 86_400_000)
    expect(calls.find(([name]) => name === "dependency-updates")?.[1]).toEqual(
      twoYearsAgo
    )
    expect(calls.find(([name]) => name === "dependency-compact")?.[1]).toEqual(
      twoYearsAgo
    )
    // Governor measurement runs before gap recovery.
    const measureIdx = calls.findIndex(([name]) => name === "measure")
    const gapsIdx = calls.findIndex(([name]) => name === "fill-gaps")
    expect(measureIdx).toBeGreaterThanOrEqual(0)
    // When coverage start equals now there is no gap work, so only assert order
    // relative to compact/promote when gaps do run.
    if (gapsIdx >= 0) {
      expect(measureIdx).toBeLessThan(gapsIdx)
    }
  })

  it("skips dependency catalog validation when the hard deadline is already spent", async () => {
    const dependencyCatalog = vi
      .fn()
      .mockResolvedValue({ checkedSources: 4, disabledPresets: 1 })
    const summary = await performMaintenance(
      baseStore({
        reconcileDependencyCatalog: dependencyCatalog,
      }),
      new Date(),
      { nowMs: () => 100, deadlineAtMs: 1 }
    )
    expect(dependencyCatalog).not.toHaveBeenCalled()
    expect(summary.dependencyCatalog).toEqual({
      checkedSources: 0,
      disabledPresets: 0,
    })
    expect(summary.deadlineExceeded).toBe(true)
    expect(
      summary.skippedTasks.some(
        (skip) => skip.task === "catalog_reconciliation"
      )
    ).toBe(true)
  })

  it("runs catalog validation under heavy retention because its slice is reserved", async () => {
    let clock = 0
    const nowMs = () => clock
    // Retention keeps returning full batches and advancing the clock, so it would
    // consume the whole window if it were not stopped at its reserved boundary.
    const raw = vi.fn(async () => {
      clock += 5000
      return 10_000
    })
    const reconcileDependencyCatalog = vi
      .fn()
      .mockResolvedValue({ checkedSources: 2, disabledPresets: 0 })
    const deadlineAtMs = 30_000
    const summary = await performMaintenance(
      baseStore({
        deleteRawChecks: raw,
        reconcileDependencyCatalog,
      }),
      new Date(),
      { nowMs, deadlineAtMs }
    )
    // Retention drained several batches yet stopped at its reserved boundary,
    // leaving the slice rather than consuming the whole window.
    expect(raw.mock.calls.length).toBeGreaterThan(1)
    expect(clock).toBe(deadlineAtMs - CATALOG_VALIDATION_BUDGET_MS)
    // Validation still ran, so heavy retention did not starve it.
    expect(reconcileDependencyCatalog).toHaveBeenCalledTimes(1)
    expect(summary.dependencyCatalog).toEqual({
      checkedSources: 2,
      disabledPresets: 0,
    })
  })

  it("bounds catalog validation to its slice so it cannot consume the whole window", async () => {
    const nowMs = () => 1000
    const reconcileDependencyCatalog = vi
      .fn()
      .mockResolvedValue({ checkedSources: 3, disabledPresets: 1 })
    // A window far wider than the slice: validation must still get only its slice.
    const deadlineAtMs = 1_000_000
    await performMaintenance(
      baseStore({
        reconcileDependencyCatalog,
      }),
      new Date(),
      { nowMs, deadlineAtMs }
    )
    expect(reconcileDependencyCatalog).toHaveBeenCalledTimes(1)
    const passedDeadline = reconcileDependencyCatalog.mock.calls[0]![1]
    // Validation is handed a deadline exactly one slice wide, never the full
    // window, so a slow set of feeds cannot overrun the maintenance deadline.
    expect(passedDeadline).toBe(1000 + CATALOG_VALIDATION_BUDGET_MS)
    expect(passedDeadline).toBeLessThan(deadlineAtMs)
  })

  it("when gap recovery consumes the pre-catalog window, compaction and promotion do not start", async () => {
    const now = new Date("2026-07-18T12:00:00Z")
    let clock = 0
    const compact = vi.fn().mockResolvedValue(1)
    const promote = vi.fn().mockResolvedValue(1)
    const measure = vi.fn().mockResolvedValue("full" as const)
    // Gap recovery burns the entire pre-catalog slice (hard 20s, catalog 10s
    // reserved => pre-catalog ends at 10s).
    const fill = vi.fn(async () => {
      clock = 10_000
      return 0
    })
    const summary = await performMaintenance(
      baseStore({
        fillSchedulerGaps: fill,
        schedulerCoverageStart: async () =>
          new Date(now.getTime() - 24 * 3_600_000),
        compact15Minute: compact,
        promoteRollups: promote,
        measureAndSnapshotUsage: measure,
        reconcileDependencyCatalog: async () => ({
          checkedSources: 1,
          disabledPresets: 0,
        }),
      }),
      now,
      { nowMs: () => clock, deadlineAtMs: 20_000 }
    )

    expect(measure).toHaveBeenCalledTimes(1)
    expect(fill).toHaveBeenCalled()
    // Recent compact/promote are separate guarded steps after gap recovery.
    // With the pre-catalog bound spent, they must not start.
    expect(compact).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
    // Catalog still gets its reserved opportunity on the hard deadline.
    expect(summary.dependencyCatalog).toEqual({
      checkedSources: 1,
      disabledPresets: 0,
    })
    expect(
      summary.skippedTasks.some((skip) => skip.reason === "pre_catalog_budget")
    ).toBe(true)
  })

  it("reads the latest stored governor mode when measurement cannot run", async () => {
    const measure = vi.fn().mockResolvedValue("shortened" as const)
    const readLatest = vi.fn().mockResolvedValue("incident_only" as const)
    // Pre-catalog bound is already spent (hard 10_000, catalog reserve 10_000
    // => pre-catalog deadline equals start). Measurement is skipped.
    const summary = await performMaintenance(
      baseStore({
        measureAndSnapshotUsage: measure,
        readLatestGovernorMode: readLatest,
        reconcileDependencyCatalog: async () => ({
          checkedSources: 0,
          disabledPresets: 0,
        }),
      }),
      new Date(),
      { nowMs: () => 0, deadlineAtMs: CATALOG_VALIDATION_BUDGET_MS }
    )

    expect(measure).not.toHaveBeenCalled()
    expect(readLatest).toHaveBeenCalledTimes(1)
    expect(summary.governorMode).toBe("incident_only")
    expect(summary.skippedTasks).toContainEqual({
      task: "usage_measurement",
      reason: "pre_catalog_budget",
    })
  })

  it("runs recent compaction and each rollup promotion as separate guarded operations", async () => {
    const order: string[] = []
    const now = new Date("2026-07-18T12:00:00Z")
    await performMaintenance(
      baseStore({
        schedulerCoverageStart: async () => now,
        compact15Minute: async () => {
          order.push("compact")
          return 1
        },
        promoteRollups: async (source, target) => {
          order.push(`promote:${source}->${target}`)
          return 1
        },
      }),
      now
    )
    // No gap work when coverage equals now. Recent path only.
    expect(order).toEqual(["compact", "promote:15m->hour", "promote:hour->day"])
  })

  it("performSweep expires only short-lived rows and sums their counts", async () => {
    const calls: string[] = []
    const count = (name: string, value: number) => async () => {
      calls.push(name)
      return value
    }
    const store = {
      expireRateLimitBuckets: count("rate", 3),
      expireApiIdempotency: count("idempotency", 2),
      markDeviceAuthorizationsExpired: count("device-mark", 1),
      deleteExpiredDeviceAuthorizations: count("device-delete", 4),
      expireConfigApprovals: count("approvals", 5),
      deleteRawChecks: count("checks", 999),
      enforceTelemetryRetention: count("telemetry", 999),
    } as unknown as MaintenanceStore
    const summary = await performSweep(store, new Date("2026-07-18T03:15:00Z"))
    expect(summary).toEqual({
      expired: 15,
      categories: {
        rateLimit: 3,
        apiIdempotency: 2,
        deviceMark: 1,
        deviceDelete: 4,
        configApprovals: 5,
      },
    })
    // Heavy retention operations are never touched by the frequent sweep.
    expect(calls).not.toContain("checks")
    expect(calls).not.toContain("telemetry")
  })

  it("performSweep fair rounds: permanent rate-limit backlog still runs later categories", async () => {
    const order: string[] = []
    let clock = 0
    // Rate-limit always returns a full batch. Under sequential drain it would
    // monopolize the window. Fair rounds give each category one batch first.
    const rate = vi.fn(async () => {
      order.push("rate")
      clock += 100
      return 10_000
    })
    const partial = (name: string, value: number) => async () => {
      order.push(name)
      clock += 100
      return value
    }
    const summary = await performSweep(
      {
        expireRateLimitBuckets: rate,
        expireApiIdempotency: partial("idempotency", 7),
        markDeviceAuthorizationsExpired: partial("device-mark", 2),
        deleteExpiredDeviceAuthorizations: partial("device-delete", 3),
        expireConfigApprovals: partial("approvals", 4),
      } as unknown as MaintenanceStore,
      new Date("2026-07-18T03:15:00Z"),
      {
        nowMs: () => clock,
        // Enough for one full fair round (5 x 100ms) plus a second rate batch,
        // then remaining drops below MIN_RETENTION_BATCH_MS.
        deadlineAtMs: 650,
      }
    )
    // First round visits every category before rate-limit can loop again.
    expect(order.slice(0, 5)).toEqual([
      "rate",
      "idempotency",
      "device-mark",
      "device-delete",
      "approvals",
    ])
    // Later categories ran despite permanent rate-limit backlog.
    expect(summary.categories.apiIdempotency).toBe(7)
    expect(summary.categories.deviceMark).toBe(2)
    expect(summary.categories.deviceDelete).toBe(3)
    expect(summary.categories.configApprovals).toBe(4)
    expect(summary.categories.rateLimit).toBeGreaterThanOrEqual(10_000)
    expect(summary.expired).toBe(
      summary.categories.rateLimit +
        summary.categories.apiIdempotency +
        summary.categories.deviceMark +
        summary.categories.deviceDelete +
        summary.categories.configApprovals
    )
  })

  it("performSweep passes remaining budget into every store operation", async () => {
    const remainingSeen: number[] = []
    const track =
      () =>
      async (...args: unknown[]) => {
        const remainingMs = args.at(-1)
        expect(typeof remainingMs).toBe("number")
        remainingSeen.push(remainingMs as number)
        return 1
      }
    await performSweep(
      {
        expireRateLimitBuckets: track(),
        expireApiIdempotency: track(),
        markDeviceAuthorizationsExpired: track(),
        deleteExpiredDeviceAuthorizations: track(),
        expireConfigApprovals: track(),
      } as unknown as MaintenanceStore,
      new Date(),
      { nowMs: () => 0, deadlineAtMs: 5000 }
    )
    expect(remainingSeen).toHaveLength(5)
    expect(remainingSeen.every((ms) => ms > 0 && ms <= 5000)).toBe(true)
  })

  it("performSweep cancels a slow category via remaining budget and continues others", async () => {
    const timeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" }
    )
    const order: string[] = []
    let clock = 0
    let rateLimitBudgetMs = 0
    const summary = await performSweep(
      {
        expireRateLimitBuckets: async (
          _now: Date,
          _limit: number,
          remainingMs?: number
        ) => {
          order.push("rate")
          rateLimitBudgetMs = remainingMs ?? 0
          clock += rateLimitBudgetMs
          throw timeout
        },
        expireApiIdempotency: async () => {
          order.push("idempotency")
          return 5
        },
        markDeviceAuthorizationsExpired: async () => {
          order.push("device-mark")
          return 1
        },
        deleteExpiredDeviceAuthorizations: async () => {
          order.push("device-delete")
          return 2
        },
        expireConfigApprovals: async () => {
          order.push("approvals")
          return 3
        },
      } as unknown as MaintenanceStore,
      new Date(),
      { nowMs: () => clock, deadlineAtMs: 5000 }
    )
    // The first category can consume only its fair share. Later categories
    // retain enough budget to run in the same pass.
    expect(rateLimitBudgetMs).toBe(1000)
    expect(order).toEqual([
      "rate",
      "idempotency",
      "device-mark",
      "device-delete",
      "approvals",
    ])
    expect(summary.categories.rateLimit).toBe(0)
    expect(summary.categories.apiIdempotency).toBe(5)
    expect(summary.expired).toBe(11)
  })

  it("performSweep starts no batch after the deadline", async () => {
    const calls: string[] = []
    // Deadline already spent: canStart(MIN_RETENTION_BATCH_MS) is false.
    const summary = await performSweep(
      {
        expireRateLimitBuckets: async () => {
          calls.push("rate")
          return 1
        },
        expireApiIdempotency: async () => {
          calls.push("idempotency")
          return 1
        },
        markDeviceAuthorizationsExpired: async () => {
          calls.push("device-mark")
          return 1
        },
        deleteExpiredDeviceAuthorizations: async () => {
          calls.push("device-delete")
          return 1
        },
        expireConfigApprovals: async () => {
          calls.push("approvals")
          return 1
        },
      } as unknown as MaintenanceStore,
      new Date(),
      { nowMs: () => 1000, deadlineAtMs: 1000 }
    )
    expect(calls).toEqual([])
    expect(summary.expired).toBe(0)
    expect(summary.categories).toEqual({
      rateLimit: 0,
      apiIdempotency: 0,
      deviceMark: 0,
      deviceDelete: 0,
      configApprovals: 0,
    })
  })

  it("performSweep does not start another batch once remaining budget is below the minimum", async () => {
    let clock = 0
    const rate = vi.fn(async () => {
      // First batch burns almost the whole window.
      clock = 900
      return 10_000
    })
    const others = vi.fn(async () => 1)
    await performSweep(
      {
        expireRateLimitBuckets: rate,
        expireApiIdempotency: others,
        markDeviceAuthorizationsExpired: others,
        deleteExpiredDeviceAuthorizations: others,
        expireConfigApprovals: others,
      } as unknown as MaintenanceStore,
      new Date(),
      // After rate runs, remaining is 100ms < MIN_RETENTION_BATCH_MS (250).
      { nowMs: () => clock, deadlineAtMs: 1000 }
    )
    // Rate advances clock mid-round. Remaining 100 < 250, so no later category
    // and no second round may start.
    expect(rate).toHaveBeenCalledTimes(1)
    expect(others).not.toHaveBeenCalled()
  })

  it("stops after the first failed task", async () => {
    const later = vi.fn()
    await expect(
      performMaintenance(
        baseStore({
          reconcileStaleOutbox: async () => {
            throw new Error("database unavailable")
          },
          reconcileStaleCronRuns: later,
          deleteRawChecks: later,
          measureAndSnapshotUsage: later,
          reconcileDependencyCatalog: later,
        }),
        new Date()
      )
    ).rejects.toThrow("database unavailable")
    expect(later).not.toHaveBeenCalled()
  })

  it("soft-skips pre-catalog statement timeouts so catalog still runs", async () => {
    const catalog = vi.fn(async () => ({
      checkedSources: 2,
      disabledPresets: 0,
    }))
    const timeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      {
        code: "57014",
      }
    )
    const summary = await performMaintenance(
      baseStore({
        deleteRawChecks: async () => {
          throw timeout
        },
        reconcileDependencyCatalog: catalog,
      }),
      new Date(),
      { nowMs: () => 0, deadlineAtMs: CATALOG_VALIDATION_BUDGET_MS + 5000 }
    )
    expect(catalog).toHaveBeenCalled()
    expect(summary.dependencyCatalog).toEqual({
      checkedSources: 2,
      disabledPresets: 0,
    })
    expect(
      summary.skippedTasks.some((entry) => entry.task === "delete_raw_checks")
    ).toBe(true)
  })

  it("classifies postgres statement timeout as a budget error", () => {
    expect(
      isStatementBudgetError(
        Object.assign(new Error("statement timeout"), { code: "57014" })
      )
    ).toBe(true)
    expect(isStatementBudgetError(new Error("database unavailable"))).toBe(
      false
    )
  })

  it("repeats full deletion batches until a short batch", async () => {
    const raw = vi
      .fn()
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(12)
    const summary = await performMaintenance(
      baseStore({
        deleteRawChecks: raw,
      }),
      new Date(),
      { nowMs: () => 0, deadlineAtMs: CATALOG_VALIDATION_BUDGET_MS + 5000 }
    )
    expect(raw).toHaveBeenCalledTimes(3)
    expect(summary.deleted).toBe(20_012)
  })

  it("stops full batches at the injected pre-catalog deadline", async () => {
    let clock = 0
    const raw = vi.fn(async () => {
      clock += 200
      return 10_000
    })
    // Pre-catalog window is 600ms. Each batch burns 200ms. Batches start while
    // remaining >= MIN_RETENTION_BATCH_MS (250).
    await performMaintenance(
      baseStore({
        deleteRawChecks: raw,
      }),
      new Date(),
      { nowMs: () => clock, deadlineAtMs: CATALOG_VALIDATION_BUDGET_MS + 600 }
    )
    expect(raw.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(raw.mock.calls.length).toBeLessThan(10)
    expect(clock).toBeLessThanOrEqual(600)
  })

  it("recovers a scheduler outage longer than 48 hours in bounded daily chunks", async () => {
    const now = new Date("2026-07-18T12:00:00Z")
    const gaps = vi.fn().mockResolvedValue(0)
    await performMaintenance(
      baseStore({
        fillSchedulerGaps: gaps,
        schedulerCoverageStart: async () =>
          new Date(now.getTime() - 72 * 3_600_000),
      }),
      now
    )
    expect(gaps).toHaveBeenCalledTimes(3)
    expect(
      gaps.mock.calls.every(
        ([start, end]) =>
          (end as Date).getTime() - (start as Date).getTime() <= 86_400_000
      )
    ).toBe(true)
  })
})
