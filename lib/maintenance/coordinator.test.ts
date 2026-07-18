import { describe, expect, it, vi } from "vitest";

import { performMaintenance } from "./coordinator";

describe("performMaintenance", () => {
  it("reconciles, compacts mergeable rollups, and uses bounded retention batches", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return 1; };
    const measure = async (...args: unknown[]) => { calls.push(["measure", ...args]); return "full" as const; };
    const now = new Date("2026-07-18T03:15:00Z");
    const summary = await performMaintenance({
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
    }, now);
    expect(calls.find(([name]) => name === "checks")?.[2]).toBe(10_000);
    expect(calls.find(([name]) => name === "snapshots")?.slice(2)).toEqual([50, 10_000]);
    expect(summary).toEqual({ staleOutbox: 1, staleCronRuns: 1, rollups: 3, deleted: 9, expired: 5, governorMode: "full" });
  });

  it("stops after the first failed task", async () => {
    const later = vi.fn();
    await expect(performMaintenance({
      reconcileStaleOutbox: async () => { throw new Error("database unavailable"); },
      reconcileStaleCronRuns: later,
      deleteRawChecks: later,
      deleteSentNotifications: later,
      expireConfigApprovals: later,
      expireApiIdempotency: later,
      markDeviceAuthorizationsExpired: later,
      deleteExpiredDeviceAuthorizations: later,
      expireRateLimitBuckets: later,
      retainConfigSnapshots: later,
      deleteOldCronRuns: later,
      deleteOldRollups: later,
      compact15Minute: later,
      fillSchedulerGaps: later,
      schedulerCoverageStart: async () => new Date(),
      promoteRollups: later,
      measureAndSnapshotUsage: async () => "full",
      enforceTelemetryRetention: later,
      retainUsageSnapshots: later,
      retainExceptions: later,
      retainExceptionPayloads: later,
    }, new Date())).rejects.toThrow("database unavailable");
    expect(later).not.toHaveBeenCalled();
  });

  it("repeats full deletion batches until a short batch", async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(12);
    const zero = vi.fn().mockResolvedValue(0);
    const summary = await performMaintenance({
      reconcileStaleOutbox: zero,
      reconcileStaleCronRuns: zero,
      deleteRawChecks: raw,
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
      enforceTelemetryRetention: zero,
      retainUsageSnapshots: zero,
      retainExceptions: zero,
      retainExceptionPayloads: zero,
    }, new Date(), { nowMs: () => 0, deadlineAtMs: 1 });
    expect(raw).toHaveBeenCalledTimes(3);
    expect(summary.deleted).toBe(20_012);
  });

  it("stops full batches at the injected deadline", async () => {
    const raw = vi.fn().mockResolvedValue(10_000);
    let clock = 0;
    const zero = vi.fn().mockResolvedValue(0);
    await performMaintenance({
      reconcileStaleOutbox: zero,
      reconcileStaleCronRuns: zero,
      deleteRawChecks: raw,
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
      enforceTelemetryRetention: zero,
      retainUsageSnapshots: zero,
      retainExceptions: zero,
      retainExceptionPayloads: zero,
    }, new Date(), { nowMs: () => clock++, deadlineAtMs: 5 });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("recovers a scheduler outage longer than 48 hours in bounded daily chunks", async () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const zero = vi.fn().mockResolvedValue(0);
    const gaps = vi.fn().mockResolvedValue(0);
    await performMaintenance({
      reconcileStaleOutbox: zero, reconcileStaleCronRuns: zero, deleteRawChecks: zero,
      deleteSentNotifications: zero, expireConfigApprovals: zero, expireApiIdempotency: zero,
      markDeviceAuthorizationsExpired: zero, deleteExpiredDeviceAuthorizations: zero,
      expireRateLimitBuckets: zero, retainConfigSnapshots: zero, deleteOldCronRuns: zero,
      deleteOldRollups: zero, compact15Minute: zero, fillSchedulerGaps: gaps,
      schedulerCoverageStart: async () => new Date(now.getTime() - 72 * 3_600_000),
      promoteRollups: zero, measureAndSnapshotUsage: async () => "full",
      enforceTelemetryRetention: zero, retainUsageSnapshots: zero, retainExceptions: zero,
      retainExceptionPayloads: zero,
    }, now);
    expect(gaps).toHaveBeenCalledTimes(3);
    expect(gaps.mock.calls.every(([start, end]) => (end as Date).getTime() - (start as Date).getTime() <= 86_400_000)).toBe(true);
  });
});
