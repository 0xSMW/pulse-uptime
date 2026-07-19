import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { hashMonitoringConfig } from "../../../lib/config/canonical";
import { validateMonitoringConfig } from "../../../lib/config/validation";
import * as schema from "../../../lib/db/schema";
import { CHUNK_SIZE, buildAcceptedFixtureConfig, insertMaintenanceAndScheduler } from "../src/fixtures";
import type { GatedConnection } from "../src/db-connection";
import { FIXTURE_EMAIL_DOMAIN, FIXTURE_URL_DOMAIN, GROUP_NAMES, MONITOR_COUNT, monitorId } from "../src/fixture-constants";

const POSTGRES_MAX_BIND_PARAMETERS = 65_535;

interface RecordedInsert {
  table: unknown;
  rowCount: number;
}

function fakeConn(): { conn: GatedConnection; inserts: RecordedInsert[] } {
  const inserts: RecordedInsert[] = [];
  const db = {
    insert(table: unknown) {
      return {
        values(rows: unknown) {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          inserts.push({ table, rowCount: rowArray.length });
          return Promise.resolve();
        },
      };
    },
  };
  return { conn: { db } as unknown as GatedConnection, inserts };
}

function buildPlan(count: number) {
  return Array.from({ length: count }, (_, zeroBased) => {
    const index = zeroBased + 1;
    return {
      id: `qh-monitor-${String(index).padStart(4, "0")}`,
      name: `Fixture Monitor ${index}`,
      url: `https://qh-monitor-${String(index).padStart(4, "0")}.example.invalid/health`,
      groupName: null,
      enabled: true,
      state: "UP" as const,
    };
  });
}

describe("buildAcceptedFixtureConfig", () => {
  it("validates and hashes a seeded accepted monitoring config with production contracts", () => {
    const plan = Array.from({ length: 5 }, (_, zeroBased) => {
      const index = zeroBased + 1;
      const id = monitorId(index);
      return {
        id,
        name: `Fixture Monitor ${index}`,
        url: `https://${id}.${FIXTURE_URL_DOMAIN}/health`,
        groupName: zeroBased % 2 === 0 ? GROUP_NAMES[0]! : null,
        enabled: true,
      };
    });

    const { config, configHash } = buildAcceptedFixtureConfig(plan);
    const revalidated = validateMonitoringConfig(config);

    expect(revalidated.schemaVersion).toBe(2);
    expect(revalidated.configVersion).toBe(1);
    expect(revalidated.settings).toMatchObject({
      concurrency: expect.any(Number),
      defaultTimeoutMs: expect.any(Number),
      defaultFailureThreshold: expect.any(Number),
      defaultRecoveryThreshold: expect.any(Number),
      defaultRecipients: [`oncall@${FIXTURE_EMAIL_DOMAIN}`],
      userAgent: expect.any(String),
    });
    expect(revalidated.monitors).toHaveLength(5);
    expect(new Set(revalidated.groups.map((group) => group.name))).toEqual(new Set(GROUP_NAMES));
    expect(configHash).toBe(hashMonitoringConfig(revalidated));
    expect(configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts the full 100-monitor fixture shape under the production size limit", () => {
    const plan = Array.from({ length: MONITOR_COUNT }, (_, zeroBased) => {
      const index = zeroBased + 1;
      const id = monitorId(index);
      return {
        id,
        name: `Fixture Monitor ${index}`,
        url: `https://${id}.${FIXTURE_URL_DOMAIN}/health`,
        groupName: zeroBased % 10 === 0 ? null : GROUP_NAMES[zeroBased % GROUP_NAMES.length]!,
        // Two archived-style disabled rows keep active count under the hard max.
        enabled: index <= MONITOR_COUNT - 2,
      };
    });

    const { config, configHash } = buildAcceptedFixtureConfig(plan);
    expect(validateMonitoringConfig(config).monitors).toHaveLength(MONITOR_COUNT);
    expect(configHash).toBe(hashMonitoringConfig(config));
  });
});

describe("insertMaintenanceAndScheduler", () => {
  it("produces exactly 60 check_batches rows and 60 atomic_minute_commits rows", async () => {
    const { conn, inserts } = fakeConn();
    const result = await insertMaintenanceAndScheduler(conn, buildPlan(5));

    expect(result.checkBatchCount).toBe(60);

    const checkBatchRows = inserts
      .filter((entry) => entry.table === schema.checkBatches)
      .reduce((sum, entry) => sum + entry.rowCount, 0);
    const commitRows = inserts
      .filter((entry) => entry.table === schema.atomicMinuteCommits)
      .reduce((sum, entry) => sum + entry.rowCount, 0);

    expect(checkBatchRows).toBe(60);
    expect(commitRows).toBe(60);
  });

  it("batches all 60 rows per table into a single chunked insert instead of one insert per minute", async () => {
    const { conn, inserts } = fakeConn();
    await insertMaintenanceAndScheduler(conn, buildPlan(5));

    const checkBatchInserts = inserts.filter((entry) => entry.table === schema.checkBatches);
    const commitInserts = inserts.filter((entry) => entry.table === schema.atomicMinuteCommits);

    // Sixty rows fit in one chunk, so each table requires one insert.
    expect(checkBatchInserts.length).toBe(1);
    expect(commitInserts.length).toBe(1);
  });

  it("still inserts the unrelated maintenance rows (cron runs, job lease, usage snapshots)", async () => {
    const { conn, inserts } = fakeConn();
    const result = await insertMaintenanceAndScheduler(conn, buildPlan(5));

    expect(result.cronRunCount).toBe(200);
    const cronRows = inserts
      .filter((entry) => entry.table === schema.cronRuns)
      .reduce((sum, entry) => sum + entry.rowCount, 0);
    expect(cronRows).toBe(200);

    const usageSnapshotRows = inserts
      .filter((entry) => entry.table === schema.databaseUsageSnapshots)
      .reduce((sum, entry) => sum + entry.rowCount, 0);
    expect(usageSnapshotRows).toBe(30);
  });
});

describe("CHUNK_SIZE parameter budget", () => {
  it("keeps a full chunk of the widest fixture row (metric_rollups) under the Postgres per-statement bind-parameter limit", () => {
    const metricRollupColumnCount = Object.keys(getTableColumns(schema.metricRollups)).length;

    // Metric rollups are the widest fixture rows, so their parameter budget
    // covers every other fixture table.
    const widestOtherTableColumnCount = Math.max(
      ...[
        schema.monitorRegistry,
        schema.monitorState,
        schema.checkResults,
        schema.dailyRollups,
        schema.incidents,
        schema.notificationOutbox,
        schema.cronRuns,
        schema.checkBatches,
        schema.atomicMinuteCommits,
        schema.databaseUsageSnapshots,
      ].map((table) => Object.keys(getTableColumns(table)).length),
    );
    expect(metricRollupColumnCount).toBeGreaterThanOrEqual(widestOtherTableColumnCount);

    expect(CHUNK_SIZE * metricRollupColumnCount).toBeLessThan(POSTGRES_MAX_BIND_PARAMETERS);
  });

  it("inserts 160,300 metric_rollups rows (the fixture's actual rollup count, 100 monitors x (8d*96 15m + 31d*24 hour + 91d day) buckets) in fewer than 100 statements", () => {
    const totalRollupRows = 160_300;
    const statementCount = Math.ceil(totalRollupRows / CHUNK_SIZE);
    expect(statementCount).toBeLessThan(100);
  });
});
