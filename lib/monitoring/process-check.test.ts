import { describe, expect, it } from "vitest";

import {
  processCheckWithStore,
  type ProcessCheckStore,
  type ProcessCheckTransaction,
} from "./process-check";
import type { MonitorStateSnapshot, ScheduledCheck } from "./types";

const checkedAt = new Date("2026-01-01T00:01:05.000Z");
const scheduledAt = new Date("2026-01-01T00:01:00.000Z");

function check(overrides: Partial<ScheduledCheck> = {}): ScheduledCheck {
  return {
    monitorId: "api",
    runId: "714749f7-46de-4af6-8a0c-166ae9698bc5",
    scheduledAt,
    checkedAt,
    successful: false,
    statusCode: 503,
    latencyMs: 40,
    effectiveUrl: "https://example.com/health",
    redirectCount: 0,
    resolvedAddress: "203.0.113.10",
    errorCode: "INVALID_STATUS",
    errorMessage: "Unexpected status 503",
    failureThreshold: 1,
    recoveryThreshold: 2,
    recipients: ["Ops@Example.com", "ops@example.com", "owner@example.com"],
    ...overrides,
  };
}

function monitor(overrides: Partial<MonitorStateSnapshot> = {}): MonitorStateSnapshot {
  return {
    monitorId: "api",
    state: "UP",
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
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeStore(options: { inserted?: boolean; state?: MonitorStateSnapshot | null } = {}) {
  const calls: string[] = [];
  const captured: { incident?: unknown; outbox?: Array<Record<string, unknown>>; state?: MonitorStateSnapshot } = {};
  const tx: ProcessCheckTransaction = {
    async insertCheck() { calls.push("insert-check"); return options.inserted ?? true; },
    async lockMonitorState() { calls.push("lock-state"); return options.state === undefined ? monitor() : options.state; },
    async insertIncident(value) { calls.push("insert-incident"); captured.incident = value; },
    async updateIncidentProgress() { calls.push("update-incident"); },
    async resolveIncident() { calls.push("resolve-incident"); },
    async insertOutbox(value) { calls.push("insert-outbox"); captured.outbox = value; },
    async updateMonitorState(value) { calls.push("update-state"); captured.state = value; },
  };
  const store: ProcessCheckStore = {
    async transaction(work) { calls.push("begin"); const result = await work(tx); calls.push("commit"); return result; },
  };
  return { store, calls, captured };
}

describe("processCheckWithStore", () => {
  it("returns an explicit duplicate without locking or transitioning", async () => {
    const fake = fakeStore({ inserted: false });
    await expect(processCheckWithStore(fake.store, check())).resolves.toEqual({
      status: "duplicate", monitorId: "api", scheduledAt,
    });
    expect(fake.calls).toEqual(["begin", "insert-check", "commit"]);
  });

  it("inserts the result before locking and persists the incident atomically", async () => {
    const fake = fakeStore();
    const result = await processCheckWithStore(fake.store, check());
    expect(result).toMatchObject({ status: "processed", previousState: "UP", state: "DOWN", event: "incident.opened" });
    if (result.status !== "processed") throw new Error("Expected processed result");
    expect(fake.calls).toEqual([
      "begin", "insert-check", "lock-state", "insert-incident", "insert-outbox", "update-state", "commit",
    ]);
    expect(fake.captured.state).toMatchObject({ state: "DOWN", activeIncidentId: result.incidentId });
  });

  it("uses stable exactly-once keys and canonical recipient addresses", async () => {
    const first = fakeStore();
    const second = fakeStore();
    await processCheckWithStore(first.store, check());
    await processCheckWithStore(second.store, check());
    expect(first.captured.outbox).toHaveLength(2);
    expect(first.captured.outbox?.map((row) => row.recipient)).toEqual(["ops@example.com", "owner@example.com"]);
    expect(first.captured.outbox?.map((row) => row.idempotencyKey))
      .toEqual(second.captured.outbox?.map((row) => row.idempotencyKey));
    expect(first.captured.outbox?.every((row) => String(row.idempotencyKey).includes("/opened/"))).toBe(true);
  });

  it("resolves an incident and queues recovery after the configured success threshold", async () => {
    const incidentId = "8c751cd3-bcf0-4cab-8348-c9b5793339ed";
    const firstSuccessAt = new Date("2026-01-01T00:00:05.000Z");
    const fake = fakeStore({ state: monitor({
      state: "VERIFYING_UP",
      activeIncidentId: incidentId,
      consecutiveSuccesses: 1,
      firstSuccessAt,
    }) });
    const result = await processCheckWithStore(fake.store, check({
      successful: true, statusCode: 200, errorCode: null, errorMessage: null,
    }));
    expect(result).toMatchObject({ status: "processed", state: "UP", incidentId, event: "incident.resolved" });
    expect(fake.calls).toEqual([
      "begin", "insert-check", "lock-state", "resolve-incident", "insert-outbox", "update-state", "commit",
    ]);
    expect(fake.captured.outbox?.every((row) => String(row.idempotencyKey).includes("/resolved/"))).toBe(true);
  });

  it("updates state without emitting an event during verification", async () => {
    const fake = fakeStore();
    const result = await processCheckWithStore(fake.store, check({ failureThreshold: 2 }));
    expect(result).toMatchObject({ status: "processed", state: "VERIFYING_DOWN", event: null });
    expect(fake.calls).toEqual(["begin", "insert-check", "lock-state", "update-state", "commit"]);
  });

  it("records the first recovery check on the active incident", async () => {
    const fake = fakeStore({ state: monitor({
      state: "DOWN",
      activeIncidentId: "8c751cd3-bcf0-4cab-8348-c9b5793339ed",
    }) });
    const result = await processCheckWithStore(fake.store, check({
      successful: true, statusCode: 200, errorCode: null, errorMessage: null,
    }));
    expect(result).toMatchObject({ status: "processed", state: "VERIFYING_UP", event: null });
    expect(fake.calls).toEqual([
      "begin", "insert-check", "lock-state", "update-incident", "update-state", "commit",
    ]);
  });

  it("updates the active incident when recovery verification fails", async () => {
    const fake = fakeStore({ state: monitor({
      state: "VERIFYING_UP",
      activeIncidentId: "8c751cd3-bcf0-4cab-8348-c9b5793339ed",
      consecutiveSuccesses: 1,
      firstSuccessAt: new Date("2026-01-01T00:00:05.000Z"),
    }) });
    const result = await processCheckWithStore(fake.store, check());
    expect(result).toMatchObject({ status: "processed", state: "DOWN", event: null });
    expect(fake.calls).toEqual([
      "begin", "insert-check", "lock-state", "update-incident", "update-state", "commit",
    ]);
  });

  it("fails the transaction when monitor state is missing", async () => {
    const fake = fakeStore({ state: null });
    await expect(processCheckWithStore(fake.store, check())).rejects.toThrow("Monitor state not found: api");
    expect(fake.calls).toEqual(["begin", "insert-check", "lock-state"]);
  });
});
