import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { encodeTelemetry, type TelemetryValue } from "@/lib/storage/codec";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("recent raw checks read straight from check_batches", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false });

  let getRecentRawChecks: typeof import("./monitors").getRecentRawChecks;
  let getRawTailCounts: typeof import("./monitors").getRawTailCounts;
  let closeModuleConnection: () => Promise<void>;

  beforeAll(async () => {
    for (const migration of ["0000_clumsy_lake.sql", "0001_device_authorization_request_ip.sql", "0002_naive_captain_stacy.sql", "0003_fast_alice.sql"]) {
      const source = await readFile(resolve(process.cwd(), "drizzle", migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
        await client.unsafe(statement);
      }
    }
    // The module under test binds its db client to DATABASE_URL at import
    // time, so the env var must point at the test database before the
    // dynamic import below evaluates lib/db/client.ts.
    process.env.DATABASE_URL = databaseUrl;
    ({ getRecentRawChecks, getRawTailCounts } = await import("./monitors"));
    const { sql } = await import("@/lib/db/client");
    closeModuleConnection = () => sql.end();
  }, 30_000);

  afterAll(async () => {
    await closeModuleConnection();
    await client.end();
  });

  async function insertBatch(minute: Date, monitorIds: readonly string[], values: readonly TelemetryValue[]): Promise<void> {
    const packed = encodeTelemetry(values);
    await client`insert into check_batches (
      scheduled_minute, encoding_version, config_version, monitor_ids,
      expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
      scheduler_started_at, scheduler_completed_at, created_at
    ) values (${minute}, ${packed.encodingVersion}, 1, ${monitorIds},
      ${packed.expectedBitmap}, ${packed.completedBitmap}, ${packed.failureBitmap}, ${packed.latencyValues},
      ${minute}, ${minute}, ${minute})`;
  }

  it("returns only a 10-minute monitor's due minutes, decodes latency, and surfaces a scheduler gap", async () => {
    const base = new Date("2026-08-05T00:00:00Z");
    for (let offset = 0; offset < 30; offset += 1) {
      const minute = new Date(base.getTime() + offset * 60_000);
      let value: TelemetryValue;
      if (offset % 10 !== 0) {
        value = { expected: false, completed: false, failed: false, latencyMs: null };
      } else if (offset === 0) {
        value = { expected: true, completed: true, failed: false, latencyMs: 137 };
      } else if (offset === 10) {
        // A minute the monitor was due but the scheduler never completed.
        value = { expected: true, completed: false, failed: false, latencyMs: null };
      } else {
        value = { expected: true, completed: true, failed: true, latencyMs: 850 };
      }
      await insertBatch(minute, ["raw-10m"], [value]);
    }

    const rows = await getRecentRawChecks("raw-10m", new Date(base.getTime() + 30 * 60_000));

    expect(rows).toEqual([
      { checked_at: new Date(base.getTime() + 20 * 60_000), completed: true, failed: true, latency_ms: 850 },
      { checked_at: new Date(base.getTime() + 10 * 60_000), completed: false, failed: false, latency_ms: null },
      { checked_at: base, completed: true, failed: false, latency_ms: 137 },
    ]);
  });

  it("resolves the monitor's array position independently per row when the roster changes mid-range", async () => {
    const early = new Date("2026-08-05T01:00:00Z");
    const late = new Date("2026-08-05T01:01:00Z");
    // "aaa-new" sorts before "zzz-target", so the target shifts from
    // position 1 to position 2 once it joins the batch's monitor_ids.
    await insertBatch(early, ["zzz-target"], [
      { expected: true, completed: true, failed: false, latencyMs: 42 },
    ]);
    await insertBatch(late, ["aaa-new", "zzz-target"], [
      { expected: false, completed: false, failed: false, latencyMs: null },
      { expected: true, completed: true, failed: false, latencyMs: 99 },
    ]);

    const rows = await getRecentRawChecks("zzz-target", new Date(late.getTime() + 60_000));

    expect(rows).toEqual([
      { checked_at: late, completed: true, failed: false, latency_ms: 99 },
      { checked_at: early, completed: true, failed: false, latency_ms: 42 },
    ]);
  });

  it("decodes latency bytes in the same big-endian order the codec writes them", async () => {
    const minute = new Date("2026-08-05T02:00:00Z");
    const latencyMs = 0x01020304;
    await insertBatch(minute, ["latency-mon"], [
      { expected: true, completed: true, failed: false, latencyMs },
    ]);

    const rows = await getRecentRawChecks("latency-mon", new Date(minute.getTime() + 60_000));

    expect(rows).toEqual([{ checked_at: minute, completed: true, failed: false, latency_ms: latencyMs }]);
  });

  it("nulls latency defensively when a completed check's bytes still carry the no-latency sentinel", async () => {
    const minute = new Date("2026-08-05T03:00:00Z");
    // Bypasses encodeTelemetry, whose invariants normally forbid this
    // combination, to exercise the SQL's defensive sentinel check directly.
    await client`insert into check_batches (
      scheduled_minute, encoding_version, config_version, monitor_ids,
      expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
      scheduler_started_at, scheduler_completed_at, created_at
    ) values (${minute}, 1, 1, ${["sentinel-mon"]},
      ${Buffer.from([0b1])}, ${Buffer.from([0b1])}, ${Buffer.from([0b0])}, ${Buffer.from([0xff, 0xff, 0xff, 0xff])},
      ${minute}, ${minute}, ${minute})`;

    const rows = await getRecentRawChecks("sentinel-mon", new Date(minute.getTime() + 60_000));

    expect(rows).toEqual([{ checked_at: minute, completed: true, failed: false, latency_ms: null }]);
  });

  it("clamps a stored latency above int4 range instead of erroring the query", async () => {
    const minute = new Date("2026-08-05T04:00:00Z");
    const packed = encodeTelemetry([
      { expected: true, completed: true, failed: false, latencyMs: 0xfffffffe },
    ]);
    await client`insert into check_batches (
      scheduled_minute, encoding_version, config_version, monitor_ids,
      expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
      scheduler_started_at, scheduler_completed_at, created_at
    ) values (${minute}, ${packed.encodingVersion}, 1, ${["overflow-mon"]},
      ${packed.expectedBitmap}, ${packed.completedBitmap}, ${packed.failureBitmap}, ${packed.latencyValues},
      ${minute}, ${minute}, ${minute})`;

    const rows = await getRecentRawChecks("overflow-mon", new Date(minute.getTime() + 60_000));

    expect(rows).toEqual([{ checked_at: minute, completed: true, failed: false, latency_ms: 2147483647 }]);
  });

  it("aggregates the full post-activation tail, past the display row cap, over the count window", async () => {
    const base = new Date("2026-08-05T06:00:00Z");
    // Twenty-five due minutes for a one-minute monitor, more than the twenty-row
    // display cap, so the aggregate proves it folds the whole tail. Minute 5 is a
    // failed check, minute 7 an unknown coverage gap.
    for (let offset = 0; offset < 25; offset += 1) {
      const minute = new Date(base.getTime() + offset * 60_000);
      let value: TelemetryValue;
      if (offset === 5) {
        value = { expected: true, completed: true, failed: true, latencyMs: 500 };
      } else if (offset === 7) {
        value = { expected: true, completed: false, failed: false, latencyMs: null };
      } else {
        value = { expected: true, completed: true, failed: false, latencyMs: 120 };
      }
      await insertBatch(minute, ["tail-mon"], [value]);
    }
    const end = new Date(base.getTime() + 25 * 60_000);

    // The whole window folds all twenty-five due minutes, well past the cap.
    expect(await getRawTailCounts("tail-mon", base, end)).toEqual({
      expected: 25,
      completed: 24,
      successful: 23,
      failed: 1,
    });

    // A later cutoff scopes the scan to the uncompacted tail, excluding the
    // failed and unknown minutes before it, so no compacted minute folds twice.
    expect(await getRawTailCounts("tail-mon", new Date(base.getTime() + 10 * 60_000), end)).toEqual({
      expected: 15,
      completed: 15,
      successful: 15,
      failed: 0,
    });

    // An empty window queries nothing and reports zeros.
    expect(await getRawTailCounts("tail-mon", end, end)).toEqual({
      expected: 0,
      completed: 0,
      successful: 0,
      failed: 0,
    });
  });

  it("degrades to an empty result instead of throwing when the raw query fails", async () => {
    const minute = new Date("2026-08-05T05:00:00Z");
    // A latency_values buffer shorter than the position's byte offsets makes
    // get_byte raise an out-of-range error, modeling a corrupt row rather
    // than a normal empty-result miss.
    await client`insert into check_batches (
      scheduled_minute, encoding_version, config_version, monitor_ids,
      expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
      scheduler_started_at, scheduler_completed_at, created_at
    ) values (${minute}, 1, 1, ${["broken-mon"]},
      ${Buffer.from([0b1])}, ${Buffer.from([0b1])}, ${Buffer.from([0b0])}, ${Buffer.from([])},
      ${minute}, ${minute}, ${minute})`;

    const rows = await getRecentRawChecks("broken-mon", new Date(minute.getTime() + 60_000));

    expect(rows).toEqual([]);
  });
});
