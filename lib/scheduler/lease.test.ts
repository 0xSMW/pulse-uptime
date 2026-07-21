import { afterEach, describe, expect, it, vi } from "vitest"

import {
  DEPENDENCY_LEASE,
  LEASE_DURATION_MS,
  type LeaseStore,
  withLease,
} from "./lease"

describe("withLease", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("requests a 90-second database-timed lease and releases the matching owner", async () => {
    const acquire = vi.fn().mockResolvedValue(true)
    const release = vi.fn().mockResolvedValue(undefined)
    const store: LeaseStore = { acquire, release }
    const now = new Date("2026-07-18T04:00:00Z")

    const result = await withLease(
      store,
      "monitor-check",
      "owner",
      now,
      async () => 42
    )

    expect(result).toEqual({ acquired: true, value: 42 })
    expect(acquire).toHaveBeenCalledWith(
      "monitor-check",
      "owner",
      LEASE_DURATION_MS
    )
    expect(release).toHaveBeenCalledWith("monitor-check", "owner")
  })

  it("does not run work when another owner holds the lease", async () => {
    const work = vi.fn()
    const result = await withLease(
      {
        acquire: vi.fn().mockResolvedValue(false),
        release: vi.fn(),
      },
      "maintenance",
      "owner",
      new Date(),
      work
    )
    expect(result).toEqual({ acquired: false })
    expect(work).not.toHaveBeenCalled()
  })

  it("preserves work success when release fails and emits secondary telemetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const store: LeaseStore = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockRejectedValue(new Error("release boom")),
    }

    const result = await withLease(
      store,
      DEPENDENCY_LEASE,
      "owner-1",
      new Date("2026-07-18T04:00:00Z"),
      async () => "ok"
    )

    expect(result).toEqual({ acquired: true, value: "ok" })
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "cron.lease_release_failed",
        leaseName: DEPENDENCY_LEASE,
        ownerId: "owner-1",
        error: "release boom",
      })
    )
  })

  it("keeps the original work error primary when release also fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const store: LeaseStore = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockRejectedValue(new Error("release boom")),
    }

    await expect(
      withLease(
        store,
        "monitor-check",
        "owner-2",
        new Date("2026-07-18T04:00:00Z"),
        async () => {
          throw new Error("work boom")
        }
      )
    ).rejects.toThrow("work boom")

    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "cron.lease_release_failed",
        leaseName: "monitor-check",
        ownerId: "owner-2",
        error: "release boom",
      })
    )
  })
})
