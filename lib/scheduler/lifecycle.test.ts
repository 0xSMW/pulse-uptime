import { describe, expect, it } from "vitest";

import type { MonitorStateSnapshot } from "@/lib/monitoring/types";

import { transitionLifecycle } from "./lifecycle";

function state(overrides: Partial<MonitorStateSnapshot> = {}): MonitorStateSnapshot {
  return {
    monitorId: "site",
    state: "DOWN",
    consecutiveFailures: 2,
    consecutiveSuccesses: 0,
    firstFailureAt: new Date("2026-07-18T03:00:00Z"),
    firstSuccessAt: null,
    lastCheckedAt: new Date("2026-07-18T03:01:00Z"),
    lastSuccessAt: null,
    lastFailureAt: new Date("2026-07-18T03:01:00Z"),
    lastStatusCode: 500,
    lastLatencyMs: 10,
    lastErrorCode: "INVALID_STATUS",
    activeIncidentId: "00000000-0000-4000-8000-000000000001",
    version: 4,
    updatedAt: new Date("2026-07-18T03:01:00Z"),
    ...overrides,
  };
}

describe("lifecycle synchronization", () => {
  it.each([
    ["PAUSED", "monitor_paused"],
    ["ARCHIVED", "monitor_archived"],
  ] as const)("terminates an incident when moving to %s", (target, reason) => {
    const result = transitionLifecycle(state(), target, new Date("2026-07-18T04:00:00Z"));
    expect(result.state.state).toBe(target);
    expect(result.state.activeIncidentId).toBeNull();
    expect(result.state.consecutiveFailures).toBe(0);
    expect(result.state.firstFailureAt).toBeNull();
    expect(result.state.version).toBe(5);
    expect(result.resolution?.reason).toBe(reason);
  });

  it("restores an archived monitor to pending with a clean sequence", () => {
    const result = transitionLifecycle(state({ state: "ARCHIVED", activeIncidentId: null }), "ACTIVE", new Date());
    expect(result.state.state).toBe("PENDING");
    expect(result.state.version).toBe(5);
    expect(result.resolution).toBeNull();
  });

  it("does not increment unchanged active state", () => {
    const result = transitionLifecycle(state({ state: "UP", activeIncidentId: null }), "ACTIVE", new Date());
    expect(result.changed).toBe(false);
    expect(result.state.version).toBe(4);
  });

  it("repairs a paused state that still references an incident", () => {
    const result = transitionLifecycle(state({ state: "PAUSED" }), "PAUSED", new Date("2026-07-18T04:00:00Z"));
    expect(result.changed).toBe(true);
    expect(result.state.version).toBe(5);
    expect(result.state.activeIncidentId).toBeNull();
    expect(result.resolution?.reason).toBe("monitor_paused");
  });
});
