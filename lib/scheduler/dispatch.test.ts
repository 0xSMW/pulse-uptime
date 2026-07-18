import { describe, expect, it, vi } from "vitest";

import type { MonitorConfig } from "@/lib/config/schema";

import { dispatchDueMonitors } from "./dispatch";

function monitor(id: string, overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    id,
    name: id,
    url: "https://example.com",
    enabled: true,
    groupId: null,
    method: "GET",
    intervalMinutes: 1,
    timeoutMs: 8_000,
    expectedStatus: { minimum: 200, maximum: 399 },
    failureThreshold: 2,
    recoveryThreshold: 2,
    recipients: [],
    ...overrides,
  };
}

describe("dispatchDueMonitors", () => {
  it("dispatches due monitors with bounded concurrency and counts outcomes", async () => {
    let running = 0;
    let peak = 0;
    const run = vi.fn(async (item: MonitorConfig) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return item.id === "bad" ? "failure" as const : "success" as const;
    });
    const result = await dispatchDueMonitors({
      monitors: [monitor("good"), monitor("bad"), monitor("later", { intervalMinutes: 5 })],
      scheduledAt: new Date("2026-07-18T04:01:00Z"),
      invocationStartedAtMs: 0,
      nowMs: () => 0,
      concurrency: 2,
      run,
    });
    expect(result).toEqual({ monitorCount: 2, successCount: 1, failureCount: 1, skippedCount: 0 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops dispatch when function time cannot fit timeout plus buffer", async () => {
    const run = vi.fn();
    const result = await dispatchDueMonitors({
      monitors: [monitor("first", { timeoutMs: 15_000 })],
      scheduledAt: new Date("2026-07-18T04:00:00Z"),
      invocationStartedAtMs: 0,
      nowMs: () => 37_001,
      concurrency: 1,
      run,
    });
    expect(result.skippedCount).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("allows work before the absolute cutoff when function time remains", async () => {
    const run = vi.fn().mockResolvedValue("success");
    const result = await dispatchDueMonitors({
      monitors: [monitor("last", { timeoutMs: 8_000 })],
      scheduledAt: new Date("2026-07-18T04:00:00Z"),
      invocationStartedAtMs: 0,
      nowMs: () => 44_000,
      concurrency: 1,
      run,
    });
    expect(result.successCount).toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });
});
