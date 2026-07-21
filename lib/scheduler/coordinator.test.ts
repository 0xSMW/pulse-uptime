import { describe, expect, it, vi } from "vitest"

import type { MonitoringConfig } from "@/lib/config/schema"

import { runMonitoringCoordinator } from "./coordinator"

const config: MonitoringConfig = {
  schemaVersion: 2,
  configVersion: 1,
  settings: {
    concurrency: 2,
    defaultTimeoutMs: 8000,
    defaultFailureThreshold: 2,
    defaultRecoveryThreshold: 2,
    defaultRecipients: [],
    userAgent: "Pulse-Uptime/1.0",
  },
  groups: [],
  monitors: [],
}

describe("runMonitoringCoordinator", () => {
  it("records and executes the documented sequence", async () => {
    const events: string[] = []
    const start = vi.fn(async () => {
      events.push("start")
      return true
    })
    const result = await runMonitoringCoordinator({
      leases: {
        acquire: async () => {
          events.push("lease")
          return true
        },
        release: async () => {
          events.push("release")
        },
      },
      runs: {
        start,
        complete: async () => {
          events.push("complete")
        },
        fail: vi.fn(),
      },
      releaseId: "dpl_test",
      loadConfig: async () => {
        events.push("config")
        return config
      },
      reconcileOutbox: async () => {
        events.push("reconcile")
        return 2
      },
      deliverOutbox: async () => {
        events.push("deliver")
        return { claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 }
      },
      runMonitor: vi.fn(),
      persistMinute: async () => {
        events.push("persist")
      },
      now: () => new Date("2026-07-18T04:00:20Z"),
      nowMs: () => 1000,
      createId: () => "00000000-0000-4000-8000-000000000001",
    })
    expect(result.status).toBe("completed")
    expect(events).toEqual([
      "lease",
      "start",
      "config",
      "reconcile",
      "deliver",
      "persist",
      "deliver",
      "complete",
      "release",
    ])
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "monitor-check",
        releaseId: "dpl_test",
      })
    )
  })

  it("does no run work for a duplicate scheduled minute", async () => {
    const loadConfig = vi.fn()
    const result = await runMonitoringCoordinator({
      leases: { acquire: async () => true, release: async () => undefined },
      runs: { start: async () => false, complete: vi.fn(), fail: vi.fn() },
      releaseId: "dpl_test",
      loadConfig,
      reconcileOutbox: vi.fn(),
      deliverOutbox: vi.fn(),
      runMonitor: vi.fn(),
      createId: () => "00000000-0000-4000-8000-000000000001",
    })
    expect(result.status).toBe("duplicate")
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it("persists dispatch counts when a late step fails", async () => {
    const fail = vi.fn()
    const dueConfig: MonitoringConfig = {
      ...config,
      monitors: [
        {
          id: "mon-one",
          name: "One",
          url: "https://example.com",
          enabled: true,
          intervalMinutes: 1,
          timeoutMs: 5000,
          failureThreshold: 2,
          recoveryThreshold: 2,
          method: "GET",
          expectedStatus: { minimum: 200, maximum: 299 },
          groupId: null,
          recipients: [],
        },
      ],
    }
    const result = await runMonitoringCoordinator({
      leases: {
        acquire: async () => true,
        release: async () => undefined,
      },
      runs: {
        start: async () => true,
        complete: vi.fn(),
        fail,
      },
      releaseId: "dpl_test",
      loadConfig: async () => dueConfig,
      reconcileOutbox: async () => 0,
      deliverOutbox: async () => ({
        claimed: 0,
        sent: 0,
        failed: 0,
        dead: 0,
        lostClaims: 0,
      }),
      runMonitor: async () => "success",
      persistMinute: async () => {
        throw new Error("persist failed")
      },
      now: () => new Date("2026-07-18T04:00:20Z"),
      nowMs: () => 1000,
      createId: () => "run-partial",
    })
    expect(result).toEqual({
      status: "failed",
      runId: "run-partial",
      error: "persist failed",
    })
    expect(fail).toHaveBeenCalledWith(
      "run-partial",
      expect.any(Date),
      expect.objectContaining({ message: "persist failed" }),
      {
        monitorCount: 1,
        successCount: 1,
        failureCount: 0,
        skippedCount: 0,
      }
    )
  })

  it("returns lease-held when the monitoring lease is held", async () => {
    const loadConfig = vi.fn()
    const result = await runMonitoringCoordinator({
      leases: {
        acquire: async () => false,
        release: vi.fn(),
      },
      runs: { start: vi.fn(), complete: vi.fn(), fail: vi.fn() },
      releaseId: "dpl_test",
      loadConfig,
      reconcileOutbox: vi.fn(),
      deliverOutbox: vi.fn(),
      runMonitor: vi.fn(),
    })
    expect(result).toEqual({ status: "lease-held" })
    expect(loadConfig).not.toHaveBeenCalled()
  })
})
