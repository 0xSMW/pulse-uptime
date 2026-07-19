// Load representative IDs and the fixture clock once per benchmark run.

import { asc, isNull, isNotNull } from "drizzle-orm";

import * as schema from "../../../lib/db/schema";
import type { GatedConnection } from "./db-connection";
import { MONITOR_COUNT } from "./fixture-constants";

export interface SampleContext {
  now: Date;
  monitorIds: string[];
  groupSlug: string;
  ongoingIncidentId: string | null;
  resolvedIncidentId: string | null;
  incidentMonitorId: string | null;
}

export async function loadSampleContext(conn: GatedConnection): Promise<SampleContext> {
  const { db } = conn;
  // Load all fixture monitors to match the production maximum of 100 IDs.
  const monitors = await db.select({ id: schema.monitorRegistry.id })
    .from(schema.monitorRegistry)
    .where(isNull(schema.monitorRegistry.archivedAt))
    .orderBy(asc(schema.monitorRegistry.id))
    .limit(MONITOR_COUNT);
  if (monitors.length === 0) {
    throw new Error("Fixture has no monitors — run the seed-fixture command before benchmarking.");
  }

  const [ongoing] = await db.select({ id: schema.incidents.id, monitorId: schema.incidents.monitorId })
    .from(schema.incidents)
    .where(isNull(schema.incidents.resolvedAt))
    .limit(1);
  const [resolved] = await db.select({ id: schema.incidents.id })
    .from(schema.incidents)
    .where(isNotNull(schema.incidents.resolvedAt))
    .limit(1);

  // Use the fixture timestamp to keep query windows over seeded data.
  // Drizzle configures the shared client to return raw timestamptz values as strings.
  const [marker] = await conn.sql<Array<{ seeded_at: string }>>`
    select seeded_at from "_query_perf_fixture" where tag = 'qh-fixture'
  `;
  if (!marker) {
    throw new Error(
      "No fixture marker found while loading sample context — run-benchmark verifies retained state before this runs, so this should be unreachable. Run seed-fixture before benchmarking.",
    );
  }
  const now = new Date(marker.seeded_at);

  return {
    now,
    monitorIds: monitors.map((monitor) => monitor.id),
    groupSlug: "api",
    ongoingIncidentId: ongoing?.id ?? null,
    resolvedIncidentId: resolved?.id ?? null,
    incidentMonitorId: ongoing?.monitorId ?? null,
  };
}
