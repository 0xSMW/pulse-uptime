import { describe, expect, it, vi } from "vitest"

import type { MonitorStateSnapshot } from "@/lib/monitoring/types"

import { PERSIST_ATOMIC_MINUTE_SQL, persistAtomicMinute } from "./atomic-minute"

const at = new Date("2026-07-18T03:15:10Z")
const state: MonitorStateSnapshot = {
  monitorId: "api",
  state: "UP",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  activatedAt: null,
  firstFailureAt: null,
  firstSuccessAt: null,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastStatusCode: null,
  lastLatencyMs: null,
  lastErrorCode: null,
  activeIncidentId: null,
  version: 3,
  updatedAt: new Date("2026-07-18T03:14:00Z"),
}

describe("atomic completed minute persistence", () => {
  it("uses one request for packed telemetry, state, incidents, exceptions, payloads, and outbox", async () => {
    const query = vi.fn().mockResolvedValue([])
    await persistAtomicMinute(
      { query },
      {
        scheduledMinute: new Date("2026-07-18T03:15:00Z"),
        configVersion: 7,
        monitorIds: ["api"],
        expectedMonitorIds: ["api"],
        states: new Map([["api", state]]),
        schedulerStartedAt: new Date("2026-07-18T03:15:01Z"),
        schedulerCompletedAt: new Date("2026-07-18T03:15:12Z"),
        results: [
          {
            monitorId: "api",
            monitorName: "API",
            checkedAt: at,
            successful: false,
            statusCode: 503,
            latencyMs: 900,
            effectiveUrl: "https://api.example.com",
            redirectCount: 0,
            resolvedAddress: "203.0.113.1",
            errorCode: "INVALID_STATUS",
            errorMessage: "HTTP 503",
            failureThreshold: 1,
            recoveryThreshold: 2,
            recipients: [
              "Ops@example.com",
              "ops@example.com",
              "owner@example.com",
            ],
          },
        ],
      }
    )
    expect(query).toHaveBeenCalledTimes(1)
    expect(PERSIST_ATOMIC_MINUTE_SQL).not.toContain("check_results")
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain("cross join batch_insert")
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain("pulse_assert_equal")
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain(
      "occurrence_count = monitor_exceptions.occurrence_count + 1"
    )
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain("first_seen_at = least")
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain("last_seen_at = greatest")
    expect(PERSIST_ATOMIC_MINUTE_SQL).toContain(
      "from jsonb_to_recordset($17::text::jsonb)"
    )
    expect(PERSIST_ATOMIC_MINUTE_SQL.trim().toLowerCase()).not.toMatch(
      /returning\s+\w+\s*$/
    )
    for (const param of [
      "$4",
      "$11",
      "$12",
      "$13",
      "$14",
      "$15",
      "$16",
      "$17",
    ]) {
      expect(PERSIST_ATOMIC_MINUTE_SQL).toContain(`${param}::text::jsonb`)
    }
    const values = query.mock.calls[0]![1]
    expect(JSON.parse(String(values[11]))).toHaveLength(1)
    const outbox = JSON.parse(String(values[14])) as Array<{
      recipient: string
      idempotencyKey: string
      payload: {
        type: string
        monitorName: string
        startedAt: string
        cause: string
      }
    }>
    expect(outbox.map((row) => row.recipient)).toEqual([
      "ops@example.com",
      "owner@example.com",
    ])
    expect(outbox.every((row) => row.idempotencyKey.includes("/opened/"))).toBe(
      true
    )
    expect(outbox[0]?.payload).toMatchObject({
      type: "incident.opened",
      monitorName: "API",
      startedAt: at.toISOString(),
      cause: "HTTP 503",
    })
    expect(JSON.parse(String(values[15]))[0]?.payload).toMatchObject({
      errorMessage: "HTTP 503",
    })
    const detail = JSON.parse(String(values[15]))[0] as {
      createdAt: string
      expiresAt: string
    }
    expect(
      new Date(detail.expiresAt).getTime() -
        new Date(detail.createdAt).getTime()
    ).toBe(30 * 86_400_000)
    expect(JSON.parse(String(values[16]))[0]).toMatchObject({
      eventType: "failure",
      latencyMs: 900,
    })
  })

  it("rejects duplicate results before making a database request", async () => {
    const query = vi.fn()
    const result = {
      monitorId: "api",
      monitorName: "API",
      checkedAt: at,
      successful: true,
      statusCode: 204,
      latencyMs: 20,
      effectiveUrl: null,
      redirectCount: 0,
      resolvedAddress: null,
      errorCode: null,
      errorMessage: null,
      failureThreshold: 2,
      recoveryThreshold: 2,
      recipients: [],
    }
    await expect(
      persistAtomicMinute(
        { query },
        {
          scheduledMinute: at,
          configVersion: 1,
          monitorIds: ["api"],
          expectedMonitorIds: ["api"],
          results: [result, result],
          states: new Map([["api", state]]),
          schedulerStartedAt: at,
          schedulerCompletedAt: at,
        }
      )
    ).rejects.toThrow("Duplicate minute result")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects completed checks whose monitor state is missing", async () => {
    const query = vi.fn()
    await expect(
      persistAtomicMinute(
        { query },
        {
          scheduledMinute: at,
          configVersion: 1,
          monitorIds: ["api"],
          expectedMonitorIds: ["api"],
          results: [
            {
              monitorId: "api",
              monitorName: "API",
              checkedAt: at,
              successful: true,
              statusCode: 204,
              latencyMs: 20,
              effectiveUrl: null,
              redirectCount: 0,
              resolvedAddress: null,
              errorCode: null,
              errorMessage: null,
              failureThreshold: 2,
              recoveryThreshold: 2,
              recipients: [],
            },
          ],
          states: new Map(),
          schedulerStartedAt: at,
          schedulerCompletedAt: at,
        }
      )
    ).rejects.toThrow("Monitor state not found: api")
    expect(query).not.toHaveBeenCalled()
  })

  it("records expected missing checks as gaps without state mutations", async () => {
    const query = vi.fn().mockResolvedValue([])
    await persistAtomicMinute(
      { query },
      {
        scheduledMinute: at,
        configVersion: 1,
        monitorIds: ["api"],
        expectedMonitorIds: ["api"],
        results: [],
        states: new Map([["api", state]]),
        schedulerStartedAt: at,
        schedulerCompletedAt: at,
      }
    )
    const values = query.mock.calls[0]![1]
    expect(JSON.parse(String(values[10]))).toEqual([])
    expect(JSON.parse(String(values[16]))).toMatchObject([
      { eventType: "scheduler_gap" },
    ])
  })

  it("sorts monitor ids and preserves packed gap telemetry", async () => {
    const query = vi.fn().mockResolvedValue([])
    await persistAtomicMinute(
      { query },
      {
        scheduledMinute: new Date("2026-07-18T03:15:00Z"),
        configVersion: 4,
        monitorIds: ["b", "a"],
        expectedMonitorIds: ["b", "a"],
        results: [
          {
            monitorId: "b",
            monitorName: "B",
            checkedAt: at,
            successful: true,
            statusCode: 204,
            latencyMs: 42,
            effectiveUrl: null,
            redirectCount: 0,
            resolvedAddress: null,
            errorCode: null,
            errorMessage: null,
            failureThreshold: 2,
            recoveryThreshold: 2,
            recipients: [],
          },
        ],
        states: new Map([["b", { ...state, monitorId: "b" }]]),
        schedulerStartedAt: new Date("2026-07-18T03:15:01Z"),
        schedulerCompletedAt: new Date("2026-07-18T03:15:04Z"),
      }
    )
    const values = query.mock.calls[0]![1]
    expect(JSON.parse(String(values[3]))).toEqual(["a", "b"])
    expect(values[4]).toBe("03")
    expect(values[5]).toBe("02")
    expect(values[6]).toBe("00")
    expect(values[7]).toBe("ffffffff0000002a")
    expect(JSON.parse(String(values[16]))).toMatchObject([
      {
        monitorId: "a",
        eventType: "scheduler_gap",
        errorCode: "SCHEDULED_CHECK_MISSING",
      },
    ])
  })

  it("requests cache invalidation only for state changes or completed 15-minute buckets", async () => {
    const query = vi.fn().mockResolvedValue([])
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const base = {
      configVersion: 1,
      monitorIds: ["api"],
      expectedMonitorIds: ["api"],
      results: [],
      states: new Map([["api", state]]),
      schedulerStartedAt: at,
      schedulerCompletedAt: at,
      invalidatePublicStatus: invalidate,
    }
    await persistAtomicMinute(
      { query },
      { ...base, scheduledMinute: new Date("2026-07-18T03:14:00Z") }
    )
    expect(invalidate).toHaveBeenCalledWith("completed-rollup-bucket")
    invalidate.mockClear()
    await persistAtomicMinute(
      { query },
      { ...base, scheduledMinute: new Date("2026-07-18T03:13:00Z") }
    )
    expect(invalidate).not.toHaveBeenCalled()
  })
})
