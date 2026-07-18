import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ __op: "eq" as const, column, value }),
    inArray: (column: unknown, values: unknown[]) => ({ __op: "inArray" as const, column, values }),
    notInArray: (column: unknown, values: unknown[]) => ({ __op: "notInArray" as const, column, values }),
    isNull: (column: unknown) => ({ __op: "isNull" as const, column }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds: conds.filter(Boolean) }),
  };
});

import type { MonitoringConfig } from "@/lib/config";
import { incidents, monitorExceptions, monitorRegistry, monitorState } from "@/lib/db/schema";
import type { MonitorStateSnapshot } from "@/lib/monitoring/types";

import type { DbTransaction } from "./registry-sync";
import { synchronizeRegistry } from "./registry-sync";

type Cond = { __op: string; column?: unknown; value?: unknown; values?: unknown[]; conds?: Cond[] };

function findOp(cond: Cond | undefined, op: string): Cond | undefined {
  if (!cond) return undefined;
  if (cond.__op === op) return cond;
  if (cond.__op === "and") {
    for (const sub of cond.conds ?? []) {
      const found = findOp(sub, op);
      if (found) return found;
    }
  }
  return undefined;
}

type RegistryRow = {
  id: string;
  name: string;
  url: string;
  groupName: string | null;
  enabled: boolean;
  configHash: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  archivedAt: Date | null;
};

type IncidentRow = {
  id: string;
  resolvedAt: Date | null;
  firstSuccessAt: Date | null;
  resolutionReason: string | null;
  updatedAt: Date;
};

type ExceptionRow = {
  id: string;
  monitorId: string;
  eventType: "pause" | "resume" | "configuration";
  errorCode: string | null;
  identityHash: Buffer;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
};

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createFakeTx(seed: { registry: RegistryRow[]; state: MonitorStateSnapshot[]; incidents: IncidentRow[] }) {
  const registryRows = new Map(seed.registry.map((row) => [row.id, { ...row }]));
  const stateRows = new Map(seed.state.map((row) => [row.monitorId, { ...row }]));
  const incidentRows = new Map(seed.incidents.map((row) => [row.id, { ...row }]));
  const exceptionRows: ExceptionRow[] = [];
  const seenExceptionKeys = new Set<string>();
  const statementLog: string[] = [];

  const tx = {
    select() {
      return {
        from(table: unknown) {
          if (table === monitorRegistry) {
            return {
              where(cond: Cond) {
                statementLog.push("select:registry-diff");
                const ids = (cond.values ?? []) as string[];
                return Promise.resolve(ids.map((id) => registryRows.get(id)).filter((row): row is RegistryRow => !!row));
              },
            };
          }
          if (table === monitorState) {
            return {
              where(cond: Cond) {
                const ids = (cond.values ?? []) as string[];
                return {
                  orderBy() {
                    return {
                      for() {
                        statementLog.push("select:state-for-update");
                        return Promise.resolve(
                          ids
                            .map((id) => stateRows.get(id))
                            .filter((row): row is MonitorStateSnapshot => !!row)
                            .map((row) => ({ ...row })),
                        );
                      },
                    };
                  },
                };
              },
            };
          }
          throw new Error("unexpected select table");
        },
      };
    },
    insert(table: unknown) {
      return {
        values(rows: unknown) {
          const list = Array.isArray(rows) ? rows : [rows];
          return {
            onConflictDoUpdate() {
              statementLog.push("insert:registry-upsert");
              for (const row of list as RegistryRow[]) {
                const existing = registryRows.get(row.id);
                registryRows.set(row.id, existing
                  ? {
                    ...existing,
                    name: row.name,
                    url: row.url,
                    groupName: row.groupName,
                    enabled: row.enabled,
                    configHash: row.configHash,
                    lastSeenAt: row.lastSeenAt,
                    archivedAt: row.archivedAt,
                  }
                  : { ...row });
              }
              return Promise.resolve();
            },
            onConflictDoNothing() {
              if (table === monitorState) {
                statementLog.push("insert:state-batch");
                for (const row of list as { monitorId: string; state: MonitorStateSnapshot["state"]; updatedAt: Date }[]) {
                  if (stateRows.has(row.monitorId)) continue;
                  stateRows.set(row.monitorId, {
                    monitorId: row.monitorId,
                    state: row.state,
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
                    updatedAt: row.updatedAt,
                  });
                }
              } else if (table === monitorExceptions) {
                statementLog.push("insert:exceptions-batch");
                for (const row of list as ExceptionRow[]) {
                  const key = `${row.monitorId}|${row.eventType}|${row.identityHash.toString("hex")}`;
                  if (seenExceptionKeys.has(key)) continue;
                  seenExceptionKeys.add(key);
                  exceptionRows.push(row);
                }
              } else {
                throw new Error("unexpected onConflictDoNothing table");
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(cond: Cond) {
              if (table === monitorRegistry) {
                statementLog.push("update:registry-removal");
                const notIn = findOp(cond, "notInArray");
                const desiredIds = new Set((notIn?.values ?? []) as string[]);
                const removedIds: { id: string }[] = [];
                for (const [id, row] of registryRows) {
                  if (row.archivedAt) continue;
                  if (desiredIds.has(id)) continue;
                  Object.assign(row, patch);
                  removedIds.push({ id });
                }
                return { returning: () => Promise.resolve(removedIds) };
              }
              if (table === incidents) {
                statementLog.push("update:incident-resolution");
                const eqCond = findOp(cond, "eq");
                const incidentId = eqCond?.value as string;
                const row = incidentRows.get(incidentId);
                const affected = !!row && row.resolvedAt === null;
                if (affected) Object.assign(row!, patch);
                const promise = Promise.resolve(undefined) as Promise<unknown> & { returning: () => Promise<{ id: string }[]> };
                promise.returning = () => Promise.resolve(affected ? [{ id: incidentId }] : []);
                return promise;
              }
              if (table === monitorState) {
                statementLog.push("update:state-change");
                const eqCond = findOp(cond, "eq");
                const id = eqCond?.value as string;
                Object.assign(stateRows.get(id)!, patch);
                return Promise.resolve();
              }
              throw new Error("unexpected update table");
            },
          };
        },
      };
    },
  };

  return { tx: tx as unknown as DbTransaction, registryRows, stateRows, incidentRows, exceptionRows, statementLog };
}

function registryRow(id: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    groupName: null,
    enabled: true,
    configHash: "hash-1",
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    archivedAt: null,
    ...overrides,
  };
}

function stateRow(monitorId: string, overrides: Partial<MonitorStateSnapshot> = {}): MonitorStateSnapshot {
  return {
    monitorId,
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
    version: 3,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function monitorConfig(id: string, overrides: Partial<MonitoringConfig["monitors"][number]> = {}): MonitoringConfig["monitors"][number] {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    enabled: true,
    method: "GET",
    intervalMinutes: 5,
    timeoutMs: 5_000,
    expectedStatus: { minimum: 200, maximum: 299 },
    failureThreshold: 2,
    recoveryThreshold: 2,
    recipients: [],
    groupId: null,
    ...overrides,
  };
}

function buildConfig(monitors: MonitoringConfig["monitors"], groups: MonitoringConfig["groups"] = []): MonitoringConfig {
  return {
    schemaVersion: 2,
    configVersion: 1,
    settings: {
      concurrency: 5,
      defaultTimeoutMs: 5_000,
      defaultFailureThreshold: 2,
      defaultRecoveryThreshold: 2,
      defaultRecipients: [],
      userAgent: "pulse-test",
    },
    groups,
    monitors,
  };
}

const now = new Date("2026-07-19T00:00:00.000Z");
const RUNTIME_MODE = { trackExceptions: true, assertIncidentResolution: true };
const API_MODE = { trackExceptions: false, assertIncidentResolution: false };

describe("synchronizeRegistry - statement bounds", () => {
  it("uses a bounded, fixed number of statements for a steady-state 100-monitor sync", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `monitor-${index}`);
    const monitors = ids.map((id) => monitorConfig(id));
    const config = buildConfig(monitors);
    const hash = "hash-1";

    const { tx, statementLog, registryRows } = createFakeTx({
      registry: ids.map((id) => registryRow(id, { configHash: hash })),
      state: ids.map((id) => stateRow(id)),
      incidents: [],
    });

    await synchronizeRegistry(tx, config, hash, now, RUNTIME_MODE);

    expect(statementLog).toEqual([
      "select:registry-diff",
      "insert:registry-upsert",
      "insert:state-batch",
      "update:registry-removal",
      "select:state-for-update",
    ]);
    expect(registryRows.get("monitor-0")?.lastSeenAt).toEqual(now);
  });

  it("scales only the per-changed-monitor updates and a single batched exception insert, not the fixed statements", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `monitor-${index}`);
    const monitors = ids.map((id) => monitorConfig(id, { enabled: false }));
    const config = buildConfig(monitors);
    const oldHash = "hash-old";
    const newHash = "hash-new";

    const { tx, statementLog, exceptionRows } = createFakeTx({
      registry: ids.map((id) => registryRow(id, { configHash: oldHash, enabled: true })),
      state: ids.map((id) => stateRow(id, { state: "UP" })),
      incidents: [],
    });

    await synchronizeRegistry(tx, config, newHash, now, RUNTIME_MODE);

    const counts = statementLog.reduce<Record<string, number>>((acc, label) => {
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts["select:registry-diff"]).toBe(1);
    expect(counts["insert:registry-upsert"]).toBe(1);
    expect(counts["insert:state-batch"]).toBe(1);
    expect(counts["update:registry-removal"]).toBe(1);
    expect(counts["select:state-for-update"]).toBe(1);
    expect(counts["insert:exceptions-batch"]).toBe(1);
    expect(counts["update:state-change"]).toBe(100);
    expect(counts["update:incident-resolution"]).toBeUndefined();
    expect(exceptionRows).toHaveLength(200);
  });
});

describe("synchronizeRegistry - semantic equivalence", () => {
  it("creates a new monitor without exceptions and leaves lifecycle untouched", async () => {
    const config = buildConfig([monitorConfig("fresh")]);
    const { tx, registryRows, stateRows, exceptionRows, statementLog } = createFakeTx({ registry: [], state: [], incidents: [] });

    await synchronizeRegistry(tx, config, "hash-1", now, RUNTIME_MODE);

    expect(registryRows.get("fresh")).toMatchObject({ firstSeenAt: now, lastSeenAt: now, archivedAt: null, enabled: true });
    expect(stateRows.get("fresh")).toMatchObject({ state: "PENDING", version: 0 });
    expect(exceptionRows).toHaveLength(0);
    expect(statementLog).not.toContain("update:state-change");
  });

  it("preserves firstSeenAt and emits a pause exception when an existing monitor is disabled", async () => {
    const config = buildConfig([monitorConfig("site", { enabled: false })]);
    const hash = "hash-1";
    const { tx, registryRows, stateRows, exceptionRows } = createFakeTx({
      registry: [registryRow("site", { configHash: hash, enabled: true, firstSeenAt: new Date("2020-01-01T00:00:00Z") })],
      state: [stateRow("site", { state: "UP", version: 5 })],
      incidents: [],
    });

    await synchronizeRegistry(tx, config, hash, now, RUNTIME_MODE);

    expect(registryRows.get("site")).toMatchObject({ enabled: false, firstSeenAt: new Date("2020-01-01T00:00:00Z"), lastSeenAt: now });
    expect(stateRows.get("site")).toMatchObject({ state: "PAUSED", version: 6 });
    expect(exceptionRows).toEqual([{
      id: deterministicUuid(`pause/site/${hash}`),
      monitorId: "site",
      eventType: "pause",
      errorCode: null,
      identityHash: createHash("sha256").update(`pause/site/${hash}`).digest(),
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
    }]);
  });

  it("emits a configuration exception (not resume/pause) when only the config hash changes", async () => {
    const config = buildConfig([monitorConfig("site")]);
    const { tx, exceptionRows } = createFakeTx({
      registry: [registryRow("site", { configHash: "hash-old", enabled: true })],
      state: [stateRow("site", { state: "UP" })],
      incidents: [],
    });

    await synchronizeRegistry(tx, config, "hash-new", now, RUNTIME_MODE);

    expect(exceptionRows).toHaveLength(1);
    expect(exceptionRows[0]).toMatchObject({ eventType: "configuration", errorCode: null, monitorId: "site" });
  });

  it("archives a removed monitor and emits pause-then-configuration exceptions with MONITOR_ARCHIVED", async () => {
    const config = buildConfig([]);
    const hash = "hash-1";
    const { tx, registryRows, stateRows, exceptionRows } = createFakeTx({
      registry: [registryRow("gone", { configHash: hash, enabled: true })],
      state: [stateRow("gone", { state: "UP" })],
      incidents: [],
    });

    await synchronizeRegistry(tx, config, hash, now, RUNTIME_MODE);

    expect(registryRows.get("gone")).toMatchObject({ enabled: false, archivedAt: now });
    expect(stateRows.get("gone")).toMatchObject({ state: "ARCHIVED" });
    expect(exceptionRows.map((row) => row.eventType)).toEqual(["pause", "configuration"]);
    expect(exceptionRows[0]).toMatchObject({ errorCode: "MONITOR_ARCHIVED" });
    expect(exceptionRows[1]).toMatchObject({ errorCode: null });
  });

  it("restores a previously archived monitor and emits a resume exception", async () => {
    const config = buildConfig([monitorConfig("back", { enabled: true })]);
    const hash = "hash-1";
    const { tx, registryRows, stateRows, exceptionRows } = createFakeTx({
      registry: [registryRow("back", { configHash: hash, enabled: false, archivedAt: new Date("2026-01-01T00:00:00Z") })],
      state: [stateRow("back", { state: "ARCHIVED", version: 4, activeIncidentId: null })],
      incidents: [],
    });

    await synchronizeRegistry(tx, config, hash, now, RUNTIME_MODE);

    expect(registryRows.get("back")).toMatchObject({ enabled: true, archivedAt: null });
    expect(stateRows.get("back")).toMatchObject({ state: "PENDING", version: 5 });
    expect(exceptionRows).toHaveLength(1);
    expect(exceptionRows[0]).toMatchObject({ eventType: "resume" });
  });

  it("resolves the active incident when a down monitor is paused, in runtime mode", async () => {
    const config = buildConfig([monitorConfig("site", { enabled: false })]);
    const hash = "hash-1";
    const { tx, incidentRows } = createFakeTx({
      registry: [registryRow("site", { configHash: hash, enabled: true })],
      state: [stateRow("site", { state: "DOWN", activeIncidentId: "inc-1", firstFailureAt: new Date("2026-07-18T00:00:00Z") })],
      incidents: [{ id: "inc-1", resolvedAt: null, firstSuccessAt: null, resolutionReason: null, updatedAt: new Date("2026-07-18T00:00:00Z") }],
    });

    await synchronizeRegistry(tx, config, hash, now, RUNTIME_MODE);

    expect(incidentRows.get("inc-1")).toMatchObject({ resolvedAt: now, resolutionReason: "monitor_paused" });
  });

  it("throws in runtime mode when the active incident row is missing, but not in API mode", async () => {
    const config = buildConfig([monitorConfig("site", { enabled: false })]);
    const hash = "hash-1";
    const seed = () => ({
      registry: [registryRow("site", { configHash: hash, enabled: true })],
      state: [stateRow("site", { state: "DOWN", activeIncidentId: "missing-incident", firstFailureAt: new Date("2026-07-18T00:00:00Z") })],
      incidents: [],
    });

    const runtimeFake = createFakeTx(seed());
    await expect(synchronizeRegistry(runtimeFake.tx, config, hash, now, RUNTIME_MODE))
      .rejects.toThrow("Active incident not found: missing-incident");

    const apiFake = createFakeTx(seed());
    await expect(synchronizeRegistry(apiFake.tx, config, hash, now, API_MODE)).resolves.toBeUndefined();
  });

  it("tracks no exceptions in API mode", async () => {
    const config = buildConfig([monitorConfig("site", { enabled: false })]);
    const hash = "hash-1";
    const { tx, exceptionRows, statementLog } = createFakeTx({
      registry: [registryRow("site", { configHash: hash, enabled: true })],
      state: [stateRow("site", { state: "UP" })],
      incidents: [],
    });

    await synchronizeRegistry(tx, config, hash, now, API_MODE);

    expect(exceptionRows).toHaveLength(0);
    expect(statementLog).not.toContain("insert:exceptions-batch");
    expect(statementLog).not.toContain("select:registry-diff");
  });
});
