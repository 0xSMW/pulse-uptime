import { describe, expect, it, vi } from "vitest";

import type { MonitoringConfig } from "@/lib/config/schema";

import { runMonitoringCoordinator } from "./coordinator";

const config: MonitoringConfig = {
  schemaVersion: 1,
  configVersion: 1,
  settings: {
    concurrency: 2,
    defaultTimeoutMs: 8_000,
    defaultFailureThreshold: 2,
    defaultRecoveryThreshold: 2,
    defaultRecipients: [],
    userAgent: "Pulse-Uptime/1.0",
  },
  monitors: [],
};

describe("runMonitoringCoordinator", () => {
  it("records and executes the documented sequence", async () => {
    const events: string[] = [];
    const result = await runMonitoringCoordinator({
      leases: {
        acquire: async () => { events.push("lease"); return true; },
        release: async () => { events.push("release"); },
      },
      runs: {
        start: async () => { events.push("start"); return true; },
        complete: async () => { events.push("complete"); },
        fail: vi.fn(),
      },
      loadConfig: async () => { events.push("config"); return config; },
      reconcileOutbox: async () => { events.push("reconcile"); return 2; },
      deliverOutbox: async () => {
        events.push("deliver");
        return { claimed: 0, sent: 0, failed: 0, dead: 0, lostClaims: 0 };
      },
      runMonitor: vi.fn(),
      persistMinute: async () => { events.push("persist"); },
      now: () => new Date("2026-07-18T04:00:20Z"),
      nowMs: () => 1_000,
      createId: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(result.status).toBe("completed");
    expect(events).toEqual(["lease", "start", "config", "reconcile", "deliver", "persist", "deliver", "complete", "release"]);
  });

  it("does no run work for a duplicate scheduled minute", async () => {
    const loadConfig = vi.fn();
    const result = await runMonitoringCoordinator({
      leases: { acquire: async () => true, release: async () => undefined },
      runs: { start: async () => false, complete: vi.fn(), fail: vi.fn() },
      loadConfig,
      reconcileOutbox: vi.fn(),
      deliverOutbox: vi.fn(),
      runMonitor: vi.fn(),
      createId: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(result.status).toBe("duplicate");
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
