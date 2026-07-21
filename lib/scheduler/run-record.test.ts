import { describe, expect, it } from "vitest"

import {
  CRON_ERROR_CAPTURE_BYTES,
  captureCronError,
  toCronRunFailure,
} from "./run-record"

// A Postgres-style error as the `postgres` package surfaces it: a plain Error
// carrying code and the diagnostic fields under their libpq names.
function pgError(message: string, fields: Record<string, string>): Error {
  return Object.assign(new Error(message), fields)
}

describe("captureCronError", () => {
  it("captures the message, name, and Postgres diagnostic fields", () => {
    const capture = captureCronError(
      pgError("duplicate key value violates unique constraint", {
        code: "23505",
        detail:
          "Key (job_name, scheduled_minute)=(monitor-check, 2026-07-20 00:00:00) already exists.",
        constraint_name: "cron_runs_job_schedule",
        table_name: "cron_runs",
        schema_name: "public",
        severity: "ERROR",
      })
    )
    expect(capture.name).toBe("Error")
    expect(capture.message).toContain("duplicate key")
    expect(capture.code).toBe("23505")
    expect(capture.detail).toContain("already exists")
    expect(capture.constraint).toBe("cron_runs_job_schedule")
    expect(capture.table).toBe("cron_runs")
    expect(capture.schema).toBe("public")
    expect(capture.severity).toBe("ERROR")
  })

  it("walks the wrapped cause chain", () => {
    const root = pgError("connection terminated unexpectedly", {
      code: "57P01",
    })
    const wrapped = new Error("loadConfig failed", { cause: root })
    const capture = captureCronError(wrapped)
    expect(capture.message).toBe("loadConfig failed")
    expect(capture.cause?.message).toContain("connection terminated")
    expect(capture.cause?.code).toBe("57P01")
  })

  it("marks truncation and stays within the byte cap for a huge error", () => {
    const capture = captureCronError(new Error("x".repeat(64 * 1024)))
    expect(capture.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThanOrEqual(
      CRON_ERROR_CAPTURE_BYTES
    )
    // The top message and name survive so the row is never useless.
    expect(capture.name).toBe("Error")
    expect(capture.message.length).toBeGreaterThan(0)
  })

  it("bounds a deep cause chain and marks it truncated", () => {
    let error = new Error("root")
    for (let level = 0; level < 12; level += 1) {
      error = new Error(`wrap ${level} ${"y".repeat(2048)}`, { cause: error })
    }
    const capture = captureCronError(error)
    expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThanOrEqual(
      CRON_ERROR_CAPTURE_BYTES
    )
    expect(capture.truncated).toBe(true)
  })

  it("captures a non-Error thrown value without throwing", () => {
    const capture = captureCronError("plain string failure")
    expect(capture.name).toBe("NonError")
    expect(capture.message).toBe("plain string failure")
  })
})

describe("toCronRunFailure", () => {
  it("pairs a single-line message with the structured capture", () => {
    const failure = toCronRunFailure(
      pgError("boom\nsecond line", { code: "XX000" })
    )
    expect(failure.message).toBe("boom second line")
    expect(failure.capture.code).toBe("XX000")
    expect(failure.capture.message).toContain("boom")
  })

  it("never throws on an exotic thrown value that throws while stringifying", () => {
    // A value whose toString throws defeats String(value) inside capture and
    // message building. The failure path runs inside the cron catch blocks, so
    // it must degrade to a minimal capture rather than throw and skip runs.fail.
    const hostile = {
      get message() {
        throw new Error("message getter explodes")
      },
      toString() {
        throw new Error("toString explodes")
      },
    }
    const failure = toCronRunFailure(hostile)
    expect(failure.message).toBe("Unrepresentable cron failure")
    expect(failure.capture.name).toBe("NonError")
    expect(failure.capture.message).toBe("Unrepresentable cron failure")
  })
})
