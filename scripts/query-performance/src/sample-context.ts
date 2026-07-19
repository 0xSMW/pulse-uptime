// Pulls representative parameter values (the seeded fixture monitor ids, an
// open incident id, a resolved incident id, and the fixture's own seed-time
// clock) out of the seeded fixture so query-cases.ts can build
// production-equivalent parameterized queries. IDs are randomUUIDs generated
// at seed time, so they can't be hardcoded — this is the one place that
// looks them up, once per benchmark run.

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
  // Load every non-archived fixture monitor (not just a small slice): several
  // query cases (e.g. the public-status-* cases) run their IN-list against
  // ctx.monitorIds the same way loadPublicStatus queries up to 100 monitors'
  // rollups/incidents in production, so a smaller sample here would scan far
  // less data than production ever does and understate real query cost.
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

  // Anchor `now` to the fixture's own seed-time clock rather than the wall
  // clock. The fixture's check/rollup rows are all generated relative to the
  // NOW captured when fixtures.ts was seeded (see fixtures.ts's module-level
  // `NOW`), so a benchmark run days after seeding would otherwise have its
  // 15m/24h window queries silently walk past the seeded data into empty
  // space while verify-state (which only checks row counts, not row recency)
  // keeps passing. run-benchmark always calls verifyRetainedState() —
  // which requires a matching marker — before loadSampleContext, so the
  // marker is guaranteed to exist here; we hard-throw instead of falling
  // back to `new Date()` because a silent wall-clock fallback would just
  // reintroduce this same drift bug under the one condition (a missing/
  // mismatched marker) where surfacing a loud error is most valuable.
  //
  // conn.sql shares its underlying postgres.js client with conn.db, and
  // drizzle() rewires that client's timestamptz parser (oid 1184) to a
  // passthrough so it can apply its own date parsing on the drizzle query
  // path -- so this raw conn.sql query gets seeded_at back as a wire-format
  // string, not a parsed Date (see the identical note in verify-state.ts).
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
