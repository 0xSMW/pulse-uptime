import { describe, expect, it, vi } from "vitest";

import { performMaintenance, performSweep, type MaintenanceStore } from "./coordinator";

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
      deleteOrphanImages: record("orphan-images"),
      validateDependencyCatalog: async (...args: unknown[]) => { calls.push(["dependency-catalog", ...args]); return { checkedSources: 1, disabledPresets: 0 }; },
      retainDependencyIncidentUpdates: record("dependency-updates"),
      compactDependencyStateIntervals: record("dependency-compact"),
    }, now);
    expect(calls.find(([name]) => name === "checks")?.[2]).toBe(10_000);
    expect(calls.find(([name]) => name === "snapshots")?.slice(2)).toEqual([50, 10_000]);
    expect(calls.find(([name]) => name === "orphan-images")?.slice(1))
      .toEqual([new Date("2026-07-17T03:15:00Z"), 20, 10_000]);
    expect(summary).toEqual({ staleOutbox: 1, staleCronRuns: 1, rollups: 3, deleted: 12, expired: 5, governorMode: "full", dependencyCatalog: { checkedSources: 1, disabledPresets: 0 } });
    // Catalog revalidation runs once per pass, not batched like the retention deletes.
    expect(calls.filter(([name]) => name === "dependency-catalog")).toHaveLength(1);
    expect(calls.find(([name]) => name === "dependency-catalog")?.[1]).toEqual(now);
    // Retention and compaction cutoffs are exactly two years before now.
    const twoYearsAgo = new Date(now.getTime() - 730 * 86_400_000);
    expect(calls.find(([name]) => name === "dependency-updates")?.[1]).toEqual(twoYearsAgo);
    expect(calls.find(([name]) => name === "dependency-compact")?.[1]).toEqual(twoYearsAgo);
  });

  it("skips dependency catalog validation when the deadline is already spent, and zeroes its summary", async () => {
    const dependencyCatalog = vi.fn().mockResolvedValue({ checkedSources: 4, disabledPresets: 1 });
    const zero = vi.fn().mockResolvedValue(0);
    // The clock is already past the deadline before any drain runs, so every
    // deadline-guarded step, including validation, is skipped.
    const summary = await performMaintenance({
      reconcileStaleOutbox: zero, reconcileStaleCronRuns: zero, deleteRawChecks: zero,
      deleteSentNotifications: zero, expireConfigApprovals: zero, expireApiIdempotency: zero,
      markDeviceAuthorizationsExpired: zero, deleteExpiredDeviceAuthorizations: zero,
      expireRateLimitBuckets: zero, retainConfigSnapshots: zero, deleteOldCronRuns: zero,
      deleteOldRollups: zero, compact15Minute: zero, fillSchedulerGaps: zero,
      schedulerCoverageStart: async (now) => now,
      promoteRollups: zero, measureAndSnapshotUsage: async () => "full",
      enforceTelemetryRetention: zero, retainUsageSnapshots: zero, retainExceptions: zero,
      retainExceptionPayloads: zero, deleteOrphanImages: zero,
      validateDependencyCatalog: dependencyCatalog,
      retainDependencyIncidentUpdates: zero, compactDependencyStateIntervals: zero,
    }, new Date(), { nowMs: () => 100, deadlineAtMs: 1 });
    expect(dependencyCatalog).not.toHaveBeenCalled();
    expect(summary.dependencyCatalog).toEqual({ checkedSources: 0, disabledPresets: 0 });
  });

  it("performSweep expires only short-lived rows and sums their counts", async () => {
    const calls: string[] = [];
    const count = (name: string, value: number) => async () => { calls.push(name); return value; };
    const store = {
      expireRateLimitBuckets: count("rate", 3),
      expireApiIdempotency: count("idempotency", 2),
      markDeviceAuthorizationsExpired: count("device-mark", 1),
      deleteExpiredDeviceAuthorizations: count("device-delete", 4),
      expireConfigApprovals: count("approvals", 5),
      deleteRawChecks: count("checks", 999),
      enforceTelemetryRetention: count("telemetry", 999),
    } as unknown as MaintenanceStore;
    const summary = await performSweep(store, new Date("2026-07-18T03:15:00Z"));
    expect(summary).toEqual({ expired: 15 });
    // Heavy retention operations are never touched by the frequent sweep.
    expect(calls).not.toContain("checks");
    expect(calls).not.toContain("telemetry");
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
      deleteOrphanImages: later,
      validateDependencyCatalog: later,
      retainDependencyIncidentUpdates: later,
      compactDependencyStateIntervals: later,
    }, new Date())).rejects.toThrow("database unavailable");
    expect(later).not.toHaveBeenCalled();
  });

  it("repeats full deletion batches until a short batch", async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(12);
    const zero = vi.fn().mockResolvedValue(0);
    const dependencyCatalog = vi.fn().mockResolvedValue({ checkedSources: 0, disabledPresets: 0 });
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
      deleteOrphanImages: zero,
      validateDependencyCatalog: dependencyCatalog,
      retainDependencyIncidentUpdates: zero,
      compactDependencyStateIntervals: zero,
    }, new Date(), { nowMs: () => 0, deadlineAtMs: 1 });
    expect(raw).toHaveBeenCalledTimes(3);
    expect(summary.deleted).toBe(20_012);
  });

  it("stops full batches at the injected deadline", async () => {
    const raw = vi.fn().mockResolvedValue(10_000);
    let clock = 0;
    const zero = vi.fn().mockResolvedValue(0);
    const dependencyCatalog = vi.fn().mockResolvedValue({ checkedSources: 0, disabledPresets: 0 });
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
      deleteOrphanImages: zero,
      validateDependencyCatalog: dependencyCatalog,
      retainDependencyIncidentUpdates: zero,
      compactDependencyStateIntervals: zero,
    }, new Date(), { nowMs: () => clock++, deadlineAtMs: 5 });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("recovers a scheduler outage longer than 48 hours in bounded daily chunks", async () => {
    const now = new Date("2026-07-18T12:00:00Z");
    const zero = vi.fn().mockResolvedValue(0);
    const gaps = vi.fn().mockResolvedValue(0);
    const dependencyCatalog = vi.fn().mockResolvedValue({ checkedSources: 0, disabledPresets: 0 });
    await performMaintenance({
      reconcileStaleOutbox: zero, reconcileStaleCronRuns: zero, deleteRawChecks: zero,
      deleteSentNotifications: zero, expireConfigApprovals: zero, expireApiIdempotency: zero,
      markDeviceAuthorizationsExpired: zero, deleteExpiredDeviceAuthorizations: zero,
      expireRateLimitBuckets: zero, retainConfigSnapshots: zero, deleteOldCronRuns: zero,
      deleteOldRollups: zero, compact15Minute: zero, fillSchedulerGaps: gaps,
      schedulerCoverageStart: async () => new Date(now.getTime() - 72 * 3_600_000),
      promoteRollups: zero, measureAndSnapshotUsage: async () => "full",
      enforceTelemetryRetention: zero, retainUsageSnapshots: zero, retainExceptions: zero,
      retainExceptionPayloads: zero, deleteOrphanImages: zero,
      validateDependencyCatalog: dependencyCatalog,
      retainDependencyIncidentUpdates: zero, compactDependencyStateIntervals: zero,
    }, now);
    expect(gaps).toHaveBeenCalledTimes(3);
    expect(gaps.mock.calls.every(([start, end]) => (end as Date).getTime() - (start as Date).getTime() <= 86_400_000)).toBe(true);
  });
});
