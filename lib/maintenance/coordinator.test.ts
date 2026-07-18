import { describe, expect, it, vi } from "vitest";

import { performMaintenance } from "./coordinator";

describe("performMaintenance", () => {
  it("reconciles, recalculates two UTC days, and uses bounded retention batches", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return 1; };
    const summary = await performMaintenance({
      reconcileStaleOutbox: record("outbox"),
      reconcileStaleCronRuns: record("cron-stale"),
      upsertDailyRollup: record("rollup"),
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
    }, new Date("2026-07-18T03:15:00Z"));
    expect(calls.filter(([name]) => name === "rollup").map(([, day]) => day))
      .toEqual(["2026-07-17", "2026-07-16"]);
    expect(calls.find(([name]) => name === "checks")?.[2]).toBe(10_000);
    expect(calls.find(([name]) => name === "snapshots")?.slice(2)).toEqual([50, 10_000]);
    expect(summary).toEqual({ staleOutbox: 1, staleCronRuns: 1, rollups: 2, deleted: 5, expired: 5 });
  });

  it("stops after the first failed task", async () => {
    const later = vi.fn();
    await expect(performMaintenance({
      reconcileStaleOutbox: async () => { throw new Error("database unavailable"); },
      reconcileStaleCronRuns: later,
      upsertDailyRollup: later,
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
      upsertDailyRollup: zero,
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
      upsertDailyRollup: zero,
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
    }, new Date(), { nowMs: () => clock++, deadlineAtMs: 1 });
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
