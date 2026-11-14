import postgres from "postgres"
import { describe, expect, it } from "vitest"

import { encodeTelemetry } from "@/lib/storage/codec"
import { RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL } from "@/lib/storage/sql"
import { observedWithRawTail } from "./live-summary"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

suite("excluded collecting tail after telemetry retention", () => {
  it("counts exclusions only in surviving failed slots, including essential mode with no raw rows", async () => {
    const client = postgres(databaseUrl!, { max: 1, prepare: false })
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(`create temporary table check_batches (
          scheduled_minute timestamptz, monitor_ids text[], expected_bitmap bytea,
          completed_bitmap bytea, failure_bitmap bytea
        ) on commit drop`)
        await tx.unsafe(`create temporary table incident_exclusions (
          id text, reverted_at timestamptz
        ) on commit drop`)
        await tx.unsafe(`create temporary table incident_exclusion_checks (
          exclusion_id text, monitor_id text, scheduled_minute timestamptz, failed boolean
        ) on commit drop`)
        await tx`insert into incident_exclusions values ('exclusion', null)`
        await tx`insert into incident_exclusion_checks values ('exclusion', 'site', '2026-11-13T00:03:00Z', true)`
        const packed = encodeTelemetry([
          { expected: true, completed: true, failed: false, latencyMs: 40 },
        ])
        await tx`insert into check_batches values (
          '2026-11-13T16:00:00Z', array['site'], ${packed.expectedBitmap}, ${packed.completedBitmap}, ${packed.failureBitmap}
        )`
        const values = [
          "site",
          "2026-11-13T00:02:00Z",
          "2026-11-13T16:01:00Z",
          "2026-11-13T00:15:00Z",
          "2026-11-13T16:00:00Z",
        ]
        const [tail] = await tx.unsafe(
          RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL,
          values
        )
        expect(tail).toMatchObject({
          expected: 1,
          completed: 1,
          successful: 1,
          failed: 0,
          excluded: 0,
        })
        expect(observedWithRawTail([], tail as never).uptime).toBe(100)
        await tx`delete from check_batches`
        const [empty] = await tx.unsafe(
          RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL,
          values
        )
        expect(empty).toMatchObject({ expected: 0, completed: 0, excluded: 0 })
        expect(observedWithRawTail([], empty as never).uptime).toBeNull()
        const failed = encodeTelemetry([
          { expected: true, completed: true, failed: true, latencyMs: 100 },
        ])
        await tx`insert into check_batches values (
          '2026-11-13T16:00:00Z', array['site'], ${failed.expectedBitmap}, ${failed.completedBitmap}, ${failed.failureBitmap}
        )`
        await tx`insert into check_batches values (
          '2026-11-13T16:01:00Z', array['site'], ${packed.expectedBitmap}, ${packed.completedBitmap}, ${packed.failureBitmap}
        )`
        await tx`insert into incident_exclusion_checks values ('exclusion', 'site', '2026-11-13T16:00:00Z', true)`
        const retainedValues = [...values]
        retainedValues[2] = "2026-11-13T16:02:00Z"
        const [active] = await tx.unsafe(
          RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL,
          retainedValues
        )
        expect(active).toMatchObject({
          expected: 2,
          completed: 2,
          successful: 1,
          failed: 1,
          excluded: 1,
        })
        expect(observedWithRawTail([], active as never)).toMatchObject({
          uptime: 100,
          coverage: 1,
        })
        await tx`update incident_exclusions set reverted_at = '2026-11-13T16:03:00Z' where id = 'exclusion'`
        const [restored] = await tx.unsafe(
          RECENT_MINUTE_CHECK_TAIL_COUNTS_SQL,
          retainedValues
        )
        expect(restored).toMatchObject({
          expected: 2,
          completed: 2,
          successful: 1,
          failed: 1,
          excluded: 0,
        })
        expect(observedWithRawTail([], restored as never)).toMatchObject({
          uptime: 50,
          coverage: 1,
        })
      })
    } finally {
      await client.end()
    }
  })
})
