import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { hashMonitoringConfig } from "../../../lib/config/canonical";
import { validateMonitoringConfig } from "../../../lib/config/validation";
import { incidentNotificationKey } from "../../../lib/notifications/idempotency";
import * as schema from "../../../lib/db/schema";
import {
  CHECK_HISTORY_HOURS,
  CHUNK_SIZE,
  MAX_FIXTURE_RECIPIENTS,
  STALE_CLAIM_CUTOFF_MS,
  STALE_SENDING_CLAIM_AGE_MS,
  buildAcceptedFixtureConfig,
  buildMonitorPlan,
  buildNotificationOutboxRows,
  fixtureRecipientsForIncident,
  insertMaintenanceAndScheduler,
} from "../src/fixtures";
import type { GatedConnection } from "../src/db-connection";
import {
  FIXTURE_EMAIL_DOMAIN,
  FIXTURE_URL_DOMAIN,
  GROUP_NAMES,
  MONITOR_COUNT,
  monitorId,
  monitorStateDistribution,
} from "../src/fixture-constants";
import { mulberry32 } from "../src/rng";

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

describe("buildNotificationOutboxRows", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");

  function sampleIncidents() {
    return [
      {
        id: "11111111-1111-1111-1111-111111111111",
        monitorId: "qh-monitor-0001",
        openedAt: new Date(now.getTime() - 3_600_000),
        resolvedAt: new Date(now.getTime() - 1_800_000),
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        monitorId: "qh-monitor-0002",
        openedAt: new Date(now.getTime() - 7_200_000),
        resolvedAt: null,
      },
      {
        id: "33333333-3333-3333-3333-333333333333",
        monitorId: "qh-monitor-0003",
        openedAt: new Date(now.getTime() - 86_400_000),
        resolvedAt: new Date(now.getTime() - 85_000_000),
      },
      {
        id: "44444444-4444-4444-4444-444444444444",
        monitorId: "qh-monitor-0004",
        openedAt: new Date(now.getTime() - 172_800_000),
        resolvedAt: null,
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        monitorId: "qh-monitor-0005",
        openedAt: new Date(now.getTime() - 259_200_000),
        resolvedAt: new Date(now.getTime() - 258_000_000),
      },
    ];
  }

  // One row per event per recipient, with fan-out keyed by incident position.
  function expectedRowCount(incidents: ReturnType<typeof sampleIncidents>): number {
    return incidents.reduce(
      (sum, incident, position) =>
        sum + (1 + (incident.resolvedAt ? 1 : 0)) * fixtureRecipientsForIncident(position).length,
      0,
    );
  }

  it("always seeds at least one stale sending row with a valid claim pair", () => {
    const claimToken = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const rows = buildNotificationOutboxRows(sampleIncidents(), {
      now,
      rand: mulberry32(0x51485f33),
      createId: () => "00000000-0000-0000-0000-000000000001",
      createClaimToken: () => claimToken,
    });

    const staleSending = rows.filter((row) => row.status === "sending");
    expect(staleSending.length).toBeGreaterThanOrEqual(1);

    for (const row of staleSending) {
      expect(row.claimToken).toBe(claimToken);
      expect(row.claimedAt).toBeInstanceOf(Date);
      expect(row.claimedAt!.getTime()).toBe(now.getTime() - STALE_SENDING_CLAIM_AGE_MS);
      expect(row.claimedAt!.getTime()).toBeLessThan(now.getTime() - STALE_CLAIM_CUTOFF_MS);
      expect(row.attemptCount).toBeGreaterThanOrEqual(1);
      expect(row.sentAt).toBeNull();
      expect(row.providerMessageId).toBeNull();
      expect(row.lastError).toBeNull();
    }
  });

  it("pairs claim fields and keeps non-sending statuses claim-free", () => {
    const incidents = sampleIncidents();
    const rows = buildNotificationOutboxRows(incidents, {
      now,
      rand: mulberry32(0x51485f33),
    });

    expect(rows.length).toBe(expectedRowCount(incidents));
    for (const row of rows) {
      const claimNull = row.claimToken == null;
      const claimedAtNull = row.claimedAt == null;
      expect(claimNull).toBe(claimedAtNull);
      if (row.status === "sending") {
        expect(claimNull).toBe(false);
      } else {
        expect(claimNull).toBe(true);
      }
    }

    const statuses = new Set(rows.map((row) => row.status));
    expect(statuses.has("sending")).toBe(true);
    // Preserve another terminal or retryable status.
    expect(statuses.has("sent") || statuses.has("pending") || statuses.has("failed") || statuses.has("dead")).toBe(true);
  });

  it("preserves one-row-per-event-per-recipient cardinality after the stale sending assignment", () => {
    const incidents = sampleIncidents();
    const rows = buildNotificationOutboxRows(incidents, {
      now,
      rand: mulberry32(7),
    });
    expect(rows).toHaveLength(expectedRowCount(incidents));
  });

  it("fans events out across deterministic recipients with production idempotency keys", () => {
    const incidents = sampleIncidents();
    const rows = buildNotificationOutboxRows(incidents, {
      now,
      rand: mulberry32(0x51485f33),
    });

    // The first incident carries the production maximum of 20 recipients.
    const maxFanOut = rows.filter(
      (row) => row.incidentId === incidents[0]!.id && row.eventType === "incident.opened",
    );
    expect(maxFanOut).toHaveLength(MAX_FIXTURE_RECIPIENTS);
    expect(new Set(maxFanOut.map((row) => row.recipient)).size).toBe(MAX_FIXTURE_RECIPIENTS);

    // At least part of the fixture keeps a single recipient per event.
    const singleFanOut = rows.filter((row) => row.incidentId === incidents[1]!.id);
    expect(singleFanOut).toHaveLength(1);

    // Every idempotency key follows the production per-recipient format.
    for (const row of rows) {
      const kind = row.eventType === "incident.opened" ? "opened" : "resolved";
      expect(row.idempotencyKey).toBe(incidentNotificationKey(row.incidentId!, kind, row.recipient));
    }
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);
  });

  it("derives recipient fan-out purely from incident position", () => {
    expect(fixtureRecipientsForIncident(0)).toHaveLength(MAX_FIXTURE_RECIPIENTS);
    expect(fixtureRecipientsForIncident(3)).toHaveLength(5);
    expect(fixtureRecipientsForIncident(1)).toHaveLength(1);
    // Recipients are stable across calls, so reseeding produces identical rows.
    expect(fixtureRecipientsForIncident(10)).toEqual(fixtureRecipientsForIncident(10));
    for (const recipient of fixtureRecipientsForIncident(0)) {
      expect(recipient.endsWith(`@${FIXTURE_EMAIL_DOMAIN}`)).toBe(true);
    }
  });

  it("makes every pending and failed row due at the fixture clock", () => {
    const rows = buildNotificationOutboxRows(sampleIncidents(), {
      now,
      rand: mulberry32(0x51485f33),
    });

    const retryable = rows.filter((row) => row.status === "pending" || row.status === "failed");
    expect(retryable.length).toBeGreaterThan(0);
    for (const row of retryable) {
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("guarantees at least one due claim-eligible row for CLAIM_NOTIFICATIONS_SQL", () => {
    // Use a fixed seed for deterministic status coverage.
    const rows = buildNotificationOutboxRows(sampleIncidents(), {
      now,
      rand: mulberry32(0x51485f33),
    });

    const claimEligible = rows.filter(
      (row) =>
        (row.status === "pending" || row.status === "failed") &&
        row.nextAttemptAt.getTime() <= now.getTime(),
    );
    expect(claimEligible.length).toBeGreaterThanOrEqual(1);
  });
});

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

describe("buildMonitorPlan", () => {
  it("seeds paused and archived monitors disabled and every other state enabled", () => {
    const plan = buildMonitorPlan();
    expect(plan).toHaveLength(MONITOR_COUNT);

    for (const monitor of plan) {
      const shouldBeDisabled = monitor.state === "PAUSED" || monitor.state === "ARCHIVED";
      expect(monitor.enabled).toBe(!shouldBeDisabled);
    }

    const expectedDisabled = monitorStateDistribution
      .filter((entry) => entry.state === "PAUSED" || entry.state === "ARCHIVED")
      .reduce((sum, entry) => sum + entry.count, 0);
    expect(plan.filter((monitor) => !monitor.enabled)).toHaveLength(expectedDisabled);
  });

  it("propagates disabled paused monitors into the accepted fixture config", () => {
    const plan = buildMonitorPlan();
    const { config } = buildAcceptedFixtureConfig(plan);
    const enabledById = new Map(config.monitors.map((monitor) => [monitor.id, monitor.enabled]));

    for (const monitor of plan) {
      expect(enabledById.get(monitor.id)).toBe(monitor.enabled);
      if (monitor.state === "PAUSED" || monitor.state === "ARCHIVED") {
        expect(enabledById.get(monitor.id)).toBe(false);
      }
    }
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

describe("raw check history window", () => {
  it("covers the dashboard's completed 24h scan window plus the 15-minute bucket alignment slack", () => {
    // listDashboardMonitors scans [end15m - 24h, end15m) where end15m floors
    // the clock by up to 15 minutes, so seeded minutes must reach back at
    // least 24h plus that slack from the fixture clock.
    expect(CHECK_HISTORY_HOURS * 60).toBeGreaterThanOrEqual(24 * 60 + 15);
  });

  it("keeps total check_results cardinality bounded for the harness", () => {
    expect(MONITOR_COUNT * CHECK_HISTORY_HOURS * 60).toBeLessThanOrEqual(150_000);
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
