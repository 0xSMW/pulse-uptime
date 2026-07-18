import { describe, expect, it } from "vitest";

import { transitionMonitor } from "./state-machine";
import type { CheckTransitionEvent, MonitorStateName, MonitorStateSnapshot } from "./types";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const minute = (value: number) => new Date(epoch.getTime() + value * 60_000);

function state(name: MonitorStateName, overrides: Partial<MonitorStateSnapshot> = {}): MonitorStateSnapshot {
  return {
    monitorId: "api",
    state: name,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    firstFailureAt: null,
    firstSuccessAt: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatusCode: null,
    lastLatencyMs: null,
    lastErrorCode: null,
    activeIncidentId: null,
    version: 0,
    updatedAt: epoch,
    ...overrides,
  };
}

function check(successful: boolean, at: Date, overrides: Partial<CheckTransitionEvent> = {}): CheckTransitionEvent {
  return {
    type: "check",
    checkedAt: at,
    successful,
    statusCode: successful ? 204 : 503,
    latencyMs: 42,
    errorCode: successful ? null : "INVALID_STATUS",
    failureThreshold: 2,
    recoveryThreshold: 2,
    ...overrides,
  };
}

describe("transitionMonitor", () => {
  it("moves a pending monitor up on its first success", () => {
    const result = transitionMonitor(state("PENDING"), check(true, minute(1)));
    expect(result.state).toMatchObject({ state: "UP", lastSuccessAt: minute(1), version: 1 });
    expect(result.incident).toBeNull();
  });

  it("keeps pending failures pending until the threshold and opens at the first failure time", () => {
    const first = transitionMonitor(state("PENDING"), check(false, minute(1)));
    expect(first.state).toMatchObject({ state: "PENDING", consecutiveFailures: 1, firstFailureAt: minute(1) });
    expect(first.incident).toBeNull();

    const second = transitionMonitor(first.state, check(false, minute(2)));
    expect(second.state.state).toBe("DOWN");
    expect(second.incident).toEqual({ type: "open", openedAt: minute(1), firstFailureAt: minute(1) });
  });

  it("verifies an outage and clears the sequence when the endpoint recovers early", () => {
    const failed = transitionMonitor(state("UP"), check(false, minute(1), { failureThreshold: 3 }));
    expect(failed.state.state).toBe("VERIFYING_DOWN");
    const recovered = transitionMonitor(failed.state, check(true, minute(2), { failureThreshold: 3 }));
    expect(recovered.state).toMatchObject({
      state: "UP", consecutiveFailures: 0, firstFailureAt: null,
    });
  });

  it("honors a failure threshold of one", () => {
    const result = transitionMonitor(state("UP"), check(false, minute(1), { failureThreshold: 1 }));
    expect(result.state.state).toBe("DOWN");
    expect(result.incident?.type).toBe("open");
  });

  it("does not create another open intent for failures while down", () => {
    const result = transitionMonitor(state("DOWN", {
      activeIncidentId: "8c751cd3-bcf0-4cab-8348-c9b5793339ed",
      consecutiveFailures: 2,
      firstFailureAt: minute(1),
    }), check(false, minute(3)));
    expect(result.state.state).toBe("DOWN");
    expect(result.incident).toBeNull();
  });

  it("verifies recovery and resolves at the first successful check", () => {
    const incidentId = "8c751cd3-bcf0-4cab-8348-c9b5793339ed";
    const down = state("DOWN", { activeIncidentId: incidentId });
    const first = transitionMonitor(down, check(true, minute(3)));
    expect(first.state).toMatchObject({ state: "VERIFYING_UP", firstSuccessAt: minute(3) });
    const second = transitionMonitor(first.state, check(true, minute(4)));
    expect(second.state).toMatchObject({ state: "UP", activeIncidentId: null });
    expect(second.incident).toEqual({
      type: "resolve", incidentId, firstSuccessAt: minute(3), resolvedAt: minute(3),
    });
  });

  it("resets recovery verification when a check fails", () => {
    const result = transitionMonitor(state("VERIFYING_UP", {
      activeIncidentId: "8c751cd3-bcf0-4cab-8348-c9b5793339ed",
      consecutiveSuccesses: 1,
      firstSuccessAt: minute(2),
    }), check(false, minute(3)));
    expect(result.state).toMatchObject({ state: "DOWN", consecutiveSuccesses: 0, firstSuccessAt: null });
    expect(result.incident).toBeNull();
  });

  it("supports one-check recovery", () => {
    const result = transitionMonitor(state("DOWN", {
      activeIncidentId: "8c751cd3-bcf0-4cab-8348-c9b5793339ed",
    }), check(true, minute(2), { recoveryThreshold: 1 }));
    expect(result.state.state).toBe("UP");
    expect(result.incident?.type).toBe("resolve");
  });

  it("does not process checks while paused or archived", () => {
    for (const name of ["PAUSED", "ARCHIVED"] as const) {
      const current = state(name);
      const result = transitionMonitor(current, check(false, minute(1)));
      expect(result.state).toBe(current);
      expect(result.changed).toBe(false);
    }
  });

  it("handles pause, archive, re-enable, and restore lifecycle transitions", () => {
    const paused = transitionMonitor(state("UP"), { type: "disable", occurredAt: minute(1) });
    expect(paused.state.state).toBe("PAUSED");
    expect(transitionMonitor(paused.state, { type: "enable", occurredAt: minute(2) }).state.state).toBe("PENDING");

    const archived = transitionMonitor(state("VERIFYING_DOWN"), { type: "archive", occurredAt: minute(1) });
    expect(archived.state.state).toBe("ARCHIVED");
    expect(transitionMonitor(archived.state, { type: "restore", occurredAt: minute(2) }).state.state).toBe("PENDING");
  });

  it("rejects invalid thresholds", () => {
    expect(() => transitionMonitor(state("UP"), check(false, minute(1), { failureThreshold: 0 })))
      .toThrow("failureThreshold must be a positive integer");
  });
});
