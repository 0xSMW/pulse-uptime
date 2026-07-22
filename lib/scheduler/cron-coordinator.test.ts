import { afterEach, describe, expect, it, vi } from "vitest"

import { runCronCoordinator } from "./cron-coordinator"
import type { CronRunCounts, CronRunStore } from "./run-record"

const counts: CronRunCounts = {
  monitorCount: 3,
  successCount: 2,
  failureCount: 1,
  skippedCount: 0,
  unknownCount: 0,
}

function emptyStore(overrides: Partial<CronRunStore> = {}): CronRunStore {
  return {
    start: vi.fn(async () => true),
    complete: vi.fn(),
    fail: vi.fn(),
    ...overrides,
  }
}

describe("runCronCoordinator", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns lease-held without starting a run when acquire fails", async () => {
    const runs = emptyStore()
    const work = vi.fn()
    const result = await runCronCoordinator(
      {
        leases: {
          acquire: vi.fn().mockResolvedValue(false),
          release: vi.fn(),
        },
        runs,
        leaseName: "monitor-check",
        jobName: "monitor-check",
        releaseId: "dpl_test",
        createId: () => "id-1",
      },
      work
    )
    expect(result).toEqual({ status: "lease-held" })
    expect(runs.start).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it("returns duplicate when the scheduled minute is already recorded", async () => {
    const work = vi.fn()
    const result = await runCronCoordinator(
      {
        leases: {
          acquire: vi.fn().mockResolvedValue(true),
          release: vi.fn().mockResolvedValue(undefined),
        },
        runs: emptyStore({ start: vi.fn(async () => false) }),
        leaseName: "dependency-check",
        jobName: "check-dependencies",
        releaseId: "dpl_test",
        now: () => new Date("2026-07-18T04:00:20Z"),
        createId: () => "run-dup",
      },
      work
    )
    expect(result).toEqual({ status: "duplicate", runId: "run-dup" })
    expect(work).not.toHaveBeenCalled()
  })

  it("completes with domain counts and releases the lease", async () => {
    const events: string[] = []
    const complete = vi.fn(async () => {
      events.push("complete")
    })
    const result = await runCronCoordinator(
      {
        leases: {
          acquire: async () => {
            events.push("lease")
            return true
          },
          release: async () => {
            events.push("release")
          },
        },
        runs: emptyStore({
          start: async () => {
            events.push("start")
            return true
          },
          complete,
        }),
        leaseName: "monitor-check",
        jobName: "monitor-check",
        releaseId: "dpl_test",
        now: () => new Date("2026-07-18T04:00:20Z"),
        createId: () => "run-ok",
      },
      async ({ runId, startedAt, scheduledMinute, progress }) => {
        events.push("work")
        expect(runId).toBe("run-ok")
        expect(startedAt.toISOString()).toBe("2026-07-18T04:00:20.000Z")
        expect(scheduledMinute.toISOString()).toBe("2026-07-18T04:00:00.000Z")
        progress.record(counts)
        return { counts, extra: 7 }
      }
    )
    expect(result).toEqual({
      status: "completed",
      runId: "run-ok",
      counts,
      extra: 7,
    })
    expect(complete).toHaveBeenCalledWith("run-ok", expect.any(Date), counts)
    expect(events).toEqual(["lease", "start", "work", "complete", "release"])
  })

  it("persists recorded progress when work fails after partial progress", async () => {
    const fail = vi.fn()
    const partial: CronRunCounts = {
      monitorCount: 4,
      successCount: 3,
      failureCount: 0,
      skippedCount: 1,
      unknownCount: 0,
    }
    const result = await runCronCoordinator(
      {
        leases: {
          acquire: vi.fn().mockResolvedValue(true),
          release: vi.fn().mockResolvedValue(undefined),
        },
        runs: emptyStore({ fail }),
        leaseName: "monitor-check",
        jobName: "monitor-check",
        releaseId: "dpl_test",
        now: () => new Date("2026-07-18T04:00:20Z"),
        createId: () => "run-fail",
      },
      async ({ progress }) => {
        progress.record(partial)
        throw new Error("persist boom")
      }
    )
    expect(result).toEqual({
      status: "failed",
      runId: "run-fail",
      error: "persist boom",
    })
    expect(fail).toHaveBeenCalledWith(
      "run-fail",
      expect.any(Date),
      expect.objectContaining({ message: "persist boom" }),
      partial
    )
  })

  it("uses empty counts on fail when no progress was recorded", async () => {
    const fail = vi.fn()
    await runCronCoordinator(
      {
        leases: {
          acquire: vi.fn().mockResolvedValue(true),
          release: vi.fn().mockResolvedValue(undefined),
        },
        runs: emptyStore({ fail }),
        leaseName: "maintenance",
        jobName: "maintenance",
        releaseId: "dpl_test",
        createId: () => "run-empty",
      },
      async () => {
        throw new Error("early boom")
      }
    )
    expect(fail).toHaveBeenCalledWith(
      "run-empty",
      expect.any(Date),
      expect.objectContaining({ message: "early boom" }),
      {
        monitorCount: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        unknownCount: 0,
      }
    )
  })

  it("preserves completed status when lease release fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const result = await runCronCoordinator(
      {
        leases: {
          acquire: vi.fn().mockResolvedValue(true),
          release: vi.fn().mockRejectedValue(new Error("release boom")),
        },
        runs: emptyStore(),
        leaseName: "monitor-check",
        jobName: "monitor-check",
        releaseId: "dpl_test",
        createId: () => "run-release",
      },
      async () => ({ counts })
    )
    expect(result).toEqual({
      status: "completed",
      runId: "run-release",
      counts,
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cron.lease_release_failed")
    )
  })
})
