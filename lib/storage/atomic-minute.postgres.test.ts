import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MonitorStateSnapshot } from "@/lib/monitoring/types";

import { persistAtomicMinute } from "./atomic-minute";
import { COMPACT_15_MINUTE_SQL, FILL_SCHEDULER_GAPS_SQL, PROMOTE_ROLLUP_SQL } from "./sql";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("atomic minute PostgreSQL transaction", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false });
  const executor = { query: async <T>(text: string, values: readonly unknown[]) =>
    await client.unsafe(text, values as never[]) as unknown as readonly T[] };
  const baseState: MonitorStateSnapshot = {
    monitorId: "api", state: "UP", consecutiveFailures: 0, consecutiveSuccesses: 0,
    activatedAt: null,
    firstFailureAt: null, firstSuccessAt: null, lastCheckedAt: null, lastSuccessAt: null,
    lastFailureAt: null, lastStatusCode: null, lastLatencyMs: null, lastErrorCode: null,
    activeIncidentId: null, version: 0, updatedAt: new Date("2026-07-18T03:00:00Z"),
  };

  beforeAll(async () => {
    // Apply every migration in order so the write path sees the current schema.
    // A hardcoded prefix goes stale the moment a later migration adds a column
    // the persist path writes, such as monitor_state.activated_at.
    const dir = resolve(process.cwd(), "drizzle");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    for (const migration of files) {
      const source = await readFile(resolve(dir, migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
        await client.unsafe(statement);
      }
    }
    await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
      values ('api', 'API', 'https://api.example.com', true, 'hash', ${baseState.updatedAt}, ${baseState.updatedAt})`;
    await client`insert into monitor_state (monitor_id, state, updated_at) values ('api', 'UP', ${baseState.updatedAt})`;
  }, 30_000);

  afterAll(async () => { await client.end(); });

  const input = (minute: Date, states: ReadonlyMap<string, MonitorStateSnapshot>) => ({
    scheduledMinute: minute, configVersion: 1, monitorIds: ["api"], expectedMonitorIds: ["api"], states,
    schedulerStartedAt: minute, schedulerCompletedAt: new Date(minute.getTime() + 1_000),
    results: [{ monitorId: "api", monitorName: "API", checkedAt: new Date(minute.getTime() + 500),
      successful: true, statusCode: 204, latencyMs: 25, effectiveUrl: null, redirectCount: 0,
      resolvedAddress: null, errorCode: null, errorMessage: null, failureThreshold: 2,
      recoveryThreshold: 2, recipients: [] }],
  });

  it("commits once and makes a duplicate minute a strict no-op", async () => {
    const minute = new Date("2026-07-18T03:15:00Z");
    await persistAtomicMinute(executor, input(minute, new Map([["api", baseState]])));
    await persistAtomicMinute(executor, input(minute, new Map([["api", baseState]])));
    const [state] = await client<{ version: number }[]>`select version from monitor_state where monitor_id = 'api'`;
    const [batches] = await client<{ count: number }[]>`select count(*)::integer count from check_batches`;
    expect(state?.version).toBe(1);
    expect(batches?.count).toBe(1);
    await client.unsafe(COMPACT_15_MINUTE_SQL, [minute, new Date("2026-07-18T03:30:00Z"), new Date("2026-07-18T03:30:00Z")] as never[]);
    const [rollup] = await client<{ expected_checks: number; completed_checks: number; latency_sum_ms: string; latency_histogram: number[] }[]>`
      select expected_checks, completed_checks, latency_sum_ms, latency_histogram from metric_rollups
      where monitor_id='api' and resolution='15m' and bucket_start=${minute}`;
    expect(rollup).toMatchObject({ expected_checks: 1, completed_checks: 1, latency_sum_ms: "25", latency_histogram: [1, 0, 0, 0, 0, 0, 0, 0] });
  });

  it("rolls the batch back when the expected state version is stale", async () => {
    const minute = new Date("2026-07-18T03:16:00Z");
    await expect(persistAtomicMinute(executor, input(minute, new Map([["api", baseState]]))))
      .rejects.toThrow("Atomic minute state version mismatch");
    const [batch] = await client<{ count: number }[]>`select count(*)::integer count from check_batches where scheduled_minute = ${minute}`;
    expect(batch?.count).toBe(0);
  });

  it("aggregates identical failures per incident and retains expiring detail payloads", async () => {
    const loadState = async () => (await client<MonitorStateSnapshot[]>`select
      monitor_id "monitorId", state, consecutive_failures "consecutiveFailures",
      consecutive_successes "consecutiveSuccesses", first_failure_at "firstFailureAt",
      first_success_at "firstSuccessAt", last_checked_at "lastCheckedAt",
      last_success_at "lastSuccessAt", last_failure_at "lastFailureAt",
      last_status_code "lastStatusCode", last_latency_ms "lastLatencyMs",
      last_error_code "lastErrorCode", active_incident_id "activeIncidentId",
      version, updated_at "updatedAt" from monitor_state where monitor_id = 'api'`)[0]!;
    const failureInput = (minute: Date, current: MonitorStateSnapshot) => ({
      ...input(minute, new Map([["api", current]])),
      results: [{ monitorId: "api", monitorName: "API", checkedAt: new Date(minute.getTime() + 500),
        successful: false, statusCode: 503, latencyMs: 900, effectiveUrl: "https://api.example.com",
        redirectCount: 0, resolvedAddress: "203.0.113.10", errorCode: "INVALID_STATUS" as const,
        errorMessage: "HTTP 503", failureThreshold: 1, recoveryThreshold: 2, recipients: ["ops@example.com"] }],
    });
    const firstMinute = new Date("2026-07-18T03:17:00Z");
    await persistAtomicMinute(executor, failureInput(firstMinute, await loadState()));
    const secondMinute = new Date("2026-07-18T03:18:00Z");
    const second = failureInput(secondMinute, await loadState());
    await persistAtomicMinute(executor, second);
    await persistAtomicMinute(executor, second);
    const [history] = await client<{ occurrence_count: number; worst_latency_ms: number }[]>`
      select occurrence_count, worst_latency_ms from monitor_exceptions
      where monitor_id = 'api' and event_type = 'failure' and incident_id is not null`;
    const [payloads] = await client<{ count: number; valid_expiry: boolean }[]>`
      select count(*)::integer count, bool_and(expires_at = created_at + interval '30 days') valid_expiry
      from exception_payloads`;
    expect(history).toMatchObject({ occurrence_count: 2, worst_latency_ms: 900 });
    expect(payloads).toEqual({ count: 2, valid_expiry: true });
  });

  it("recovers more than 48 hours of missing scheduler coverage as Unknown", async () => {
    const coverageStart = new Date("2026-07-19T00:00:00Z");
    const scanStart = new Date("2026-07-19T00:15:00Z");
    const scanEnd = new Date("2026-07-22T00:15:00Z");
    await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
      values ('gap-api', 'Gap API', 'https://gap.example.com', true, 'gap-hash', ${coverageStart}, ${coverageStart})`;
    await client`insert into monitoring_config_snapshots
      (id, config_version, config_hash, config_json, status, source, seen_at, accepted_at)
      values ('11111111-1111-4111-8111-111111111111', 2, 'gap-config',
        ${client.json({ monitors: [{ id: "gap-api", enabled: true, intervalMinutes: 1 }] })}::jsonb,
        'accepted', 'test', ${coverageStart}, ${coverageStart})`;
    await client`insert into metric_rollups
      (monitor_id, resolution, bucket_start, expected_checks, completed_checks, successful_checks,
       failed_checks, unknown_checks, downtime_seconds, unknown_seconds, latency_count, latency_sum_ms,
       latency_histogram, histogram_version, has_incident, compacted_at)
      values ('gap-api', '15m', ${coverageStart}, 15, 15, 15, 0, 0, 0, 0, 15, 150,
        array[15,0,0,0,0,0,0,0], 1, false, ${coverageStart})`;

    await client.unsafe(FILL_SCHEDULER_GAPS_SQL, [
      new Date("2024-07-22T00:15:00Z"), scanEnd, scanEnd,
    ] as never[]);

    const [batches] = await client<{ count: number }[]>`select count(*)::integer count from check_batches
      where scheduled_minute >= ${scanStart} and scheduled_minute < ${scanEnd}`;
    const [exceptions] = await client<{ count: number }[]>`select count(*)::integer count from monitor_exceptions
      where monitor_id = 'gap-api' and event_type = 'scheduler_gap'`;
    expect(batches?.count).toBe(72 * 60);
    expect(exceptions?.count).toBe(72 * 60);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.unsafe(COMPACT_15_MINUTE_SQL, [scanStart, scanEnd, scanEnd] as never[]);
      await client.unsafe(PROMOTE_ROLLUP_SQL, ["15m", "hour", scanStart, scanEnd] as never[]);
      await client.unsafe(PROMOTE_ROLLUP_SQL, ["hour", "day", scanStart, scanEnd] as never[]);
    }
    const [daily] = await client<{ expected: number; completed: number; unknown: number; rows: number }[]>`
      select sum(expected_checks)::integer expected, sum(completed_checks)::integer completed,
        sum(unknown_checks)::integer unknown, count(*)::integer rows
      from metric_rollups where monitor_id = 'gap-api' and resolution = 'day'`;
    expect(daily).toMatchObject({ expected: 72 * 60, completed: 15, unknown: 72 * 60 - 15 });
    expect(daily?.rows).toBe(3);
  });

  it("picks the accepted snapshot whose range covers each minute across a mid-gap config change", async () => {
    const scanStart = new Date("2026-07-25T00:00:00Z");
    const boundary = new Date("2026-07-25T00:05:00Z");
    const scanEnd = new Date("2026-07-25T00:10:00Z");
    await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
      values ('gap-a', 'Gap A', 'https://gap-a.example.com', true, 'gap-a-hash', ${scanStart}, ${scanStart}),
        ('gap-b', 'Gap B', 'https://gap-b.example.com', true, 'gap-b-hash', ${scanStart}, ${scanStart})`;
    await client`insert into monitoring_config_snapshots
      (id, config_version, config_hash, config_json, status, source, seen_at, accepted_at)
      values
        ('22222222-2222-4222-8222-222222222222', 30, 'gap-config-30',
          ${client.json({ monitors: [{ id: "gap-a", enabled: true, intervalMinutes: 1 }] })}::jsonb,
          'accepted', 'test', ${new Date("2026-07-24T23:00:00Z")}, ${new Date("2026-07-24T23:00:00Z")}),
        ('33333333-3333-4333-8333-333333333333', 31, 'gap-config-31',
          ${client.json({ monitors: [
            { id: "gap-a", enabled: true, intervalMinutes: 1 },
            { id: "gap-b", enabled: true, intervalMinutes: 1 },
          ] })}::jsonb,
          'accepted', 'test', ${boundary}, ${boundary})`;

    // scanStart is far past any covered_until/accepted_start from earlier
    // tests, so it wins the greatest() and scan_start lands exactly here.
    await client.unsafe(FILL_SCHEDULER_GAPS_SQL, [scanStart, scanEnd, scanEnd] as never[]);

    const batches = await client<{ scheduled_minute: Date; config_version: number; monitor_ids: string[]; expected_bitmap: Buffer }[]>`
      select scheduled_minute, config_version, monitor_ids, expected_bitmap from check_batches
      where scheduled_minute >= ${scanStart} and scheduled_minute < ${scanEnd}
      order by scheduled_minute`;
    expect(batches).toHaveLength(10);
    const before = batches.filter((row) => row.scheduled_minute < boundary);
    const after = batches.filter((row) => row.scheduled_minute >= boundary);
    expect(before).toHaveLength(5);
    expect(after).toHaveLength(5);
    for (const row of before) {
      expect(row.config_version).toBe(30);
      expect(row.monitor_ids).toEqual(["gap-a"]);
      expect(row.expected_bitmap).toEqual(Buffer.from([0b00000001]));
    }
    for (const row of after) {
      expect(row.config_version).toBe(31);
      expect(row.monitor_ids).toEqual(["gap-a", "gap-b"]);
      expect(row.expected_bitmap).toEqual(Buffer.from([0b00000011]));
    }

    const [exceptions] = await client<{ gap_a: number; gap_b: number }[]>`
      select
        count(*) filter (where monitor_id = 'gap-a')::integer gap_a,
        count(*) filter (where monitor_id = 'gap-b')::integer gap_b
      from monitor_exceptions where event_type = 'scheduler_gap' and monitor_id in ('gap-a', 'gap-b')`;
    expect(exceptions).toEqual({ gap_a: 10, gap_b: 5 });
  });
});
