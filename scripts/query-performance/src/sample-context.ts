// Pulls representative parameter values (a handful of real fixture monitor
// ids, an open incident id, a resolved incident id) out of the seeded
// fixture so query-cases.ts can build production-equivalent parameterized
// queries. IDs are randomUUIDs generated at seed time, so they can't be
// hardcoded — this is the one place that looks them up, once per benchmark
// run.

import { asc, isNull, isNotNull } from "drizzle-orm";

import * as schema from "../../../lib/db/schema";
import type { GatedConnection } from "./db-connection";

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
  const monitors = await db.select({ id: schema.monitorRegistry.id })
    .from(schema.monitorRegistry)
    .where(isNull(schema.monitorRegistry.archivedAt))
    .orderBy(asc(schema.monitorRegistry.id))
    .limit(10);
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

  return {
    now: new Date(),
    monitorIds: monitors.map((monitor) => monitor.id),
    groupSlug: "api",
    ongoingIncidentId: ongoing?.id ?? null,
    resolvedIncidentId: resolved?.id ?? null,
    incidentMonitorId: ongoing?.monitorId ?? null,
  };
}
