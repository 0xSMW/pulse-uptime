import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, notInArray, sql as drizzleSql } from "drizzle-orm";

import type { MonitoringConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { incidents, monitorExceptions, monitorRegistry, monitorState } from "@/lib/db/schema";
import type { MonitorStateSnapshot } from "@/lib/monitoring/types";

import { transitionLifecycle, type LifecycleTarget } from "./lifecycle";

export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type RegistrySyncMode = {
  // Runtime records configuration, pause, and resume notification exceptions.
  // The API path skips them.
  trackExceptions: boolean;
  // Runtime requires incident resolution to update one row.
  // The API path permits a no-op.
  assertIncidentResolution: boolean;
};

type ExceptionEventType = "pause" | "resume" | "configuration";

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function synchronizeRegistry(
  tx: DbTransaction,
  config: MonitoringConfig,
  hash: string,
  now: Date,
  mode: RegistrySyncMode,
): Promise<void> {
  const groupNames = new Map(config.groups.map((group) => [group.id, group.name]));
  const desiredIds = config.monitors.map((monitor) => monitor.id);

  const previousRegistryById = new Map<string, { configHash: string; enabled: boolean }>();
  if (mode.trackExceptions && desiredIds.length > 0) {
    const previous = await tx.select({
      id: monitorRegistry.id,
      configHash: monitorRegistry.configHash,
      enabled: monitorRegistry.enabled,
    }).from(monitorRegistry).where(inArray(monitorRegistry.id, desiredIds));
    for (const row of previous) previousRegistryById.set(row.id, row);
  }

  if (config.monitors.length > 0) {
    await tx.insert(monitorRegistry).values(config.monitors.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      groupName: monitor.groupId ? groupNames.get(monitor.groupId) ?? null : null,
      enabled: monitor.enabled,
      configHash: hash,
      firstSeenAt: now,
      lastSeenAt: now,
      archivedAt: null,
    }))).onConflictDoUpdate({
      target: monitorRegistry.id,
      set: {
        name: drizzleSql`excluded.name`,
        url: drizzleSql`excluded.url`,
        groupName: drizzleSql`excluded.group_name`,
        enabled: drizzleSql`excluded.enabled`,
        configHash: drizzleSql`excluded.config_hash`,
        lastSeenAt: drizzleSql`excluded.last_seen_at`,
        archivedAt: drizzleSql`excluded.archived_at`,
      },
    });

    await tx.insert(monitorState).values(config.monitors.map((monitor) => ({
      monitorId: monitor.id,
      state: monitor.enabled ? "PENDING" as const : "PAUSED" as const,
      updatedAt: now,
    }))).onConflictDoNothing();
  }

  const removed = await tx.update(monitorRegistry).set({
    enabled: false,
    archivedAt: now,
    lastSeenAt: now,
  }).where(and(isNull(monitorRegistry.archivedAt), notInArray(monitorRegistry.id, desiredIds)))
    .returning({ id: monitorRegistry.id });
  const removedIds = removed.map((row) => row.id);

  const allIds = [...desiredIds, ...removedIds];
  const statesByMonitorId = new Map<string, MonitorStateSnapshot>();
  if (allIds.length > 0) {
    const states = await tx.select().from(monitorState)
      .where(inArray(monitorState.monitorId, allIds))
      .orderBy(monitorState.monitorId)
      .for("update");
    for (const state of states) statesByMonitorId.set(state.monitorId, state);
  }

  const exceptionRows: (typeof monitorExceptions.$inferInsert)[] = [];
  const addException = (monitorId: string, eventType: ExceptionEventType, errorCode: string | null) => {
    if (!mode.trackExceptions) return;
    const identity = `${eventType}/${monitorId}/${hash}`;
    exceptionRows.push({
      id: deterministicUuid(identity),
      monitorId,
      eventType,
      errorCode,
      identityHash: createHash("sha256").update(identity).digest(),
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
    });
  };

  const applyLifecycle = async (monitorId: string, target: LifecycleTarget) => {
    const current = statesByMonitorId.get(monitorId);
    if (!current) throw new Error(`Monitor state not found: ${monitorId}`);
    const mutation = transitionLifecycle(current, target, now);
    if (!mutation.changed) return;
    if (mutation.resolution) {
      const resolution = tx.update(incidents).set({
        firstSuccessAt: mutation.resolution.resolvedAt,
        resolvedAt: mutation.resolution.resolvedAt,
        resolutionReason: mutation.resolution.reason,
        updatedAt: now,
      }).where(and(
        eq(incidents.id, mutation.resolution.incidentId),
        isNull(incidents.resolvedAt),
      ));
      if (mode.assertIncidentResolution) {
        const resolved = await resolution.returning({ id: incidents.id });
        if (resolved.length !== 1) throw new Error(`Active incident not found: ${mutation.resolution.incidentId}`);
      } else {
        await resolution;
      }
    }
    await tx.update(monitorState).set({
      state: mutation.state.state,
      consecutiveFailures: mutation.state.consecutiveFailures,
      consecutiveSuccesses: mutation.state.consecutiveSuccesses,
      firstFailureAt: mutation.state.firstFailureAt,
      firstSuccessAt: mutation.state.firstSuccessAt,
      activeIncidentId: mutation.state.activeIncidentId,
      version: mutation.state.version,
      updatedAt: mutation.state.updatedAt,
    }).where(eq(monitorState.monitorId, monitorId));
  };

  for (const monitor of config.monitors) {
    await applyLifecycle(monitor.id, monitor.enabled ? "ACTIVE" : "PAUSED");
    const previous = previousRegistryById.get(monitor.id);
    if (previous && previous.configHash !== hash) addException(monitor.id, "configuration", null);
    if (previous && previous.enabled !== monitor.enabled) {
      addException(monitor.id, monitor.enabled ? "resume" : "pause", null);
    }
  }

  for (const id of removedIds) {
    await applyLifecycle(id, "ARCHIVED");
    addException(id, "pause", "MONITOR_ARCHIVED");
    addException(id, "configuration", null);
  }

  if (exceptionRows.length > 0) {
    await tx.insert(monitorExceptions).values(exceptionRows).onConflictDoNothing();
  }
}
