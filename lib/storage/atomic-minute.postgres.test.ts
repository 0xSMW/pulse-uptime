import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MonitorStateSnapshot } from "@/lib/monitoring/types";

import { persistAtomicMinute } from "./atomic-minute";
import { FILL_SCHEDULER_GAPS_SQL } from "./sql";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("atomic minute PostgreSQL transaction", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false });
  const executor = { query: async <T>(text: string, values: readonly unknown[]) => {
    try {
      return await client.unsafe(text, values as never[]) as unknown as readonly T[];
    } catch (error) {
      const position = Number((error as { position?: string }).position ?? 0);
      const jsonKinds = values.slice(10).map((value) => {
        try { return Array.isArray(JSON.parse(String(value))) ? "array" : "other"; } catch { return typeof value; }
      });
      const postgresKinds: unknown[] = [];
      for (const value of values.slice(10)) {
        postgresKinds.push(await client.unsafe("select jsonb_typeof($1::jsonb) kind", [value] as never[]));
      }
      throw new Error(`${(error as Error).message} json=${jsonKinds.join(",")} pg=${JSON.stringify(postgresKinds)} near ${text.slice(Math.max(0, position - 80), position + 80)}`);
    }
  } };
  const baseState: MonitorStateSnapshot = {
    monitorId: "api", state: "UP", consecutiveFailures: 0, consecutiveSuccesses: 0,
    firstFailureAt: null, firstSuccessAt: null, lastCheckedAt: null, lastSuccessAt: null,
    lastFailureAt: null, lastStatusCode: null, lastLatencyMs: null, lastErrorCode: null,
    activeIncidentId: null, version: 0, updatedAt: new Date("2026-07-18T03:00:00Z"),
  };

  beforeAll(async () => {
    for (const migration of ["0000_clumsy_lake.sql", "0001_device_authorization_request_ip.sql", "0002_naive_captain_stacy.sql", "0003_fast_alice.sql"]) {
      const source = await readFile(resolve(process.cwd(), "drizzle", migration), "utf8");
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
  });

  it("rolls the batch back when the expected state version is stale", async () => {
    const minute = new Date("2026-07-18T03:16:00Z");
    await expect(persistAtomicMinute(executor, input(minute, new Map([["api", baseState]]))))
      .rejects.toThrow("Atomic minute state version mismatch");
    const [batch] = await client<{ count: number }[]>`select count(*)::integer count from check_batches where scheduled_minute = ${minute}`;
    expect(batch?.count).toBe(0);
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
  });
});
