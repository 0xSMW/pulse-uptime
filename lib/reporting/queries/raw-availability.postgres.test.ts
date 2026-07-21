import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { encodeTelemetry, type TelemetryValue } from "@/lib/storage/codec"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

suite("scheduler-derived raw availability from check_batches", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false })

  let fetchRawAvailabilityBuckets: typeof import("./raw-availability").fetchRawAvailabilityBuckets
  let RAW_AVAILABILITY_BUCKETS_SQL: typeof import("./raw-availability").RAW_AVAILABILITY_BUCKETS_SQL
  let closeModuleConnection: () => Promise<void>

  beforeAll(async () => {
    for (const migration of [
      "0000_clumsy_lake.sql",
      "0001_device_authorization_request_ip.sql",
      "0002_naive_captain_stacy.sql",
      "0003_fast_alice.sql",
    ]) {
      const source = await readFile(
        resolve(process.cwd(), "drizzle", migration),
        "utf8"
      )
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((item) => item.trim())
        .filter(Boolean)) {
        await client.unsafe(statement)
      }
    }
    process.env.DATABASE_URL = databaseUrl
    ;({ fetchRawAvailabilityBuckets, RAW_AVAILABILITY_BUCKETS_SQL } =
      await import("./raw-availability"))
    const { sql } = await import("@/lib/db/client")
    closeModuleConnection = () => sql.end()
  }, 30_000)

  afterAll(async () => {
    await closeModuleConnection()
    await client.end()
  })

  async function insertBatch(
    minute: Date,
    monitorIds: readonly string[],
    values: readonly TelemetryValue[]
  ): Promise<void> {
    const packed = encodeTelemetry(values)
    await client`insert into check_batches (
      scheduled_minute, encoding_version, config_version, monitor_ids,
      expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
      scheduler_started_at, scheduler_completed_at, created_at
    ) values (${minute}, ${packed.encodingVersion}, 1, ${monitorIds},
      ${packed.expectedBitmap}, ${packed.completedBitmap}, ${packed.failureBitmap}, ${packed.latencyValues},
      ${minute}, ${minute}, ${minute})
    on conflict (scheduled_minute) do update set
      encoding_version = excluded.encoding_version,
      config_version = excluded.config_version,
      monitor_ids = excluded.monitor_ids,
      expected_bitmap = excluded.expected_bitmap,
      completed_bitmap = excluded.completed_bitmap,
      failure_bitmap = excluded.failure_bitmap,
      latency_values = excluded.latency_values,
      scheduler_started_at = excluded.scheduler_started_at,
      scheduler_completed_at = excluded.scheduler_completed_at,
      created_at = excluded.created_at`
  }

  it("counts 15 expected with one successful completion as incomplete coverage", async () => {
    const base = new Date("2026-09-01T00:00:00Z")
    for (let offset = 0; offset < 15; offset += 1) {
      const minute = new Date(base.getTime() + offset * 60_000)
      const value: TelemetryValue =
        offset === 0
          ? { expected: true, completed: true, failed: false, latencyMs: 40 }
          : { expected: true, completed: false, failed: false, latencyMs: null }
      await insertBatch(minute, ["raw-gap"], [value])
    }

    const rows = await fetchRawAvailabilityBuckets(
      ["raw-gap"],
      base,
      new Date(base.getTime() + 15 * 60_000)
    )

    expect(rows).toEqual([
      {
        monitorId: "raw-gap",
        bucketStart: base,
        expectedChecks: 15,
        completedChecks: 1,
        successfulChecks: 1,
        failedChecks: 0,
        unknownChecks: 14,
        downtimeSeconds: 0,
      },
    ])
  })

  it("counts a fully completed successful bucket with full coverage", async () => {
    const base = new Date("2026-09-01T01:00:00Z")
    for (let offset = 0; offset < 15; offset += 1) {
      const minute = new Date(base.getTime() + offset * 60_000)
      await insertBatch(
        minute,
        ["raw-full"],
        [{ expected: true, completed: true, failed: false, latencyMs: 50 }]
      )
    }

    const rows = await fetchRawAvailabilityBuckets(
      ["raw-full"],
      base,
      new Date(base.getTime() + 15 * 60_000)
    )

    expect(rows).toEqual([
      {
        monitorId: "raw-full",
        bucketStart: base,
        expectedChecks: 15,
        completedChecks: 15,
        successfulChecks: 15,
        failedChecks: 0,
        unknownChecks: 0,
        downtimeSeconds: 0,
      },
    ])
  })

  it("counts expected with zero completions as unknown-only coverage", async () => {
    const base = new Date("2026-09-01T02:00:00Z")
    for (let offset = 0; offset < 15; offset += 1) {
      const minute = new Date(base.getTime() + offset * 60_000)
      await insertBatch(
        minute,
        ["raw-none"],
        [{ expected: true, completed: false, failed: false, latencyMs: null }]
      )
    }

    const rows = await fetchRawAvailabilityBuckets(
      ["raw-none"],
      base,
      new Date(base.getTime() + 15 * 60_000)
    )

    expect(rows).toEqual([
      {
        monitorId: "raw-none",
        bucketStart: base,
        expectedChecks: 15,
        completedChecks: 0,
        successfulChecks: 0,
        failedChecks: 0,
        unknownChecks: 15,
        downtimeSeconds: 0,
      },
    ])
  })

  it("reads the monitor's ordinal bit when the roster holds multiple monitors", async () => {
    const minute = new Date("2026-09-01T03:00:00Z")
    // target sits in position 2: expected+completed success. neighbors differ.
    await insertBatch(
      minute,
      ["aaa", "target", "zzz"],
      [
        { expected: true, completed: true, failed: true, latencyMs: 900 },
        { expected: true, completed: true, failed: false, latencyMs: 12 },
        { expected: true, completed: false, failed: false, latencyMs: null },
      ]
    )

    const rows = await fetchRawAvailabilityBuckets(
      ["target"],
      minute,
      new Date(minute.getTime() + 60_000)
    )

    expect(rows).toEqual([
      {
        monitorId: "target",
        bucketStart: new Date("2026-09-01T03:00:00Z"),
        expectedChecks: 1,
        completedChecks: 1,
        successfulChecks: 1,
        failedChecks: 0,
        unknownChecks: 0,
        downtimeSeconds: 0,
      },
    ])
  })

  it("groups failed completions separately from successful and unknown", async () => {
    const base = new Date("2026-09-01T04:00:00Z")
    const values: TelemetryValue[] = [
      { expected: true, completed: true, failed: false, latencyMs: 10 },
      { expected: true, completed: true, failed: true, latencyMs: 800 },
      { expected: true, completed: false, failed: false, latencyMs: null },
    ]
    for (let offset = 0; offset < 3; offset += 1) {
      await insertBatch(
        new Date(base.getTime() + offset * 60_000),
        ["raw-mix"],
        [values[offset]!]
      )
    }

    const rows = await fetchRawAvailabilityBuckets(
      ["raw-mix"],
      base,
      new Date(base.getTime() + 15 * 60_000)
    )

    expect(rows).toEqual([
      {
        monitorId: "raw-mix",
        bucketStart: base,
        expectedChecks: 3,
        completedChecks: 2,
        successfulChecks: 1,
        failedChecks: 1,
        unknownChecks: 1,
        downtimeSeconds: 0,
      },
    ])
  })

  it("ranges the primary key before unnest on a bounded window", async () => {
    // Seed a minute well outside the queried window so a full-table unnest would
    // pull it in. The plan and the result must stay scoped to the range.
    const inside = new Date("2026-09-01T05:00:00Z")
    const outside = new Date("2026-09-01T10:00:00Z")
    await insertBatch(
      inside,
      ["raw-plan"],
      [{ expected: true, completed: true, failed: false, latencyMs: 20 }]
    )
    await insertBatch(
      outside,
      ["raw-plan"],
      [{ expected: true, completed: true, failed: false, latencyMs: 20 }]
    )

    const start = inside
    const end = new Date(inside.getTime() + 15 * 60_000)
    const rows = await fetchRawAvailabilityBuckets(["raw-plan"], start, end)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.bucketStart).toEqual(inside)

    const planRows = (await client.unsafe(
      `explain (format json) ${RAW_AVAILABILITY_BUCKETS_SQL}`,
      [start.toISOString(), end.toISOString(), ["raw-plan"]]
    )) as Array<{ "QUERY PLAN": unknown }>
    const planText = JSON.stringify(planRows)
    // The ranged CTE must constrain scheduled_minute. A plan that only filters
    // after unnesting the whole table would miss this Index Cond / Filter pair.
    expect(planText).toMatch(/scheduled_minute/i)
    // Unnest is a function scan, but the base relation should not be a bare
    // sequential read of every retained minute without a range condition.
    const hasRangeAccess =
      /Index (?:Only )?Scan|Bitmap (?:Index|Heap) Scan|Index Cond|scheduled_minute/i.test(
        planText
      )
    expect(hasRangeAccess).toBe(true)
  })
})
