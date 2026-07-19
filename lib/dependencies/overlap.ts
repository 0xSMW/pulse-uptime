import "server-only";

import { and, asc, eq, isNull, sql as dsql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { dependencies, dependencyCatalog, dependencyIncidentMatches, dependencySources, providerIncidents } from "@/lib/db/schema";

// Neutral timing context for a Pulse monitor incident, per
// Docs/DEPENDENCY-MONITORING.md "Incident overlap query": installed
// dependency incidents whose window overlaps the monitor incident's window,
// ordered by how close the provider's start sits to the monitor's start.
// This never ranks by severity and never claims causation, only timing.

export type MonitorIncidentWindow = { openedAt: Date; resolvedAt: Date | null };

export type DependencyIncidentOverlap = {
  dependencyId: string;
  dependencyName: string;
  provider: string;
  incidentId: string;
  incidentTitle: string;
  providerStartedAt: string;
  providerResolvedAt: string | null;
  canonicalUrl: string | null;
  matchKind: string;
  /** Provider start minus monitor start, in seconds. Positive: provider started after the monitor incident opened. */
  offsetSeconds: number;
};

export async function listOverlappingDependencyIncidents(
  monitorIncident: MonitorIncidentWindow,
): Promise<DependencyIncidentOverlap[]> {
  const openedAtIso = monitorIncident.openedAt.toISOString();
  const resolvedAtIso = monitorIncident.resolvedAt?.toISOString() ?? null;

  const rows = await db.select({
    dependencyId: dependencies.id,
    dependencyName: dependencyCatalog.displayName,
    provider: dependencySources.providerName,
    incidentId: providerIncidents.id,
    incidentTitle: providerIncidents.title,
    providerStartedAt: providerIncidents.startedAt,
    providerResolvedAt: providerIncidents.resolvedAt,
    canonicalUrl: providerIncidents.canonicalUrl,
    statusPageUrl: dependencySources.statusPageUrl,
    matchKind: dependencyIncidentMatches.matchKind,
  }).from(dependencyIncidentMatches)
    .innerJoin(providerIncidents, eq(providerIncidents.id, dependencyIncidentMatches.incidentId))
    .innerJoin(dependencies, eq(dependencies.id, dependencyIncidentMatches.dependencyId))
    .innerJoin(dependencyCatalog, eq(dependencyCatalog.id, dependencies.catalogId))
    .innerJoin(dependencySources, eq(dependencySources.id, providerIncidents.sourceId))
    .where(and(
      isNull(dependencies.removedAt),
      dsql`${providerIncidents.startedAt} <= coalesce(${resolvedAtIso}::timestamptz, now())`,
      dsql`coalesce(${providerIncidents.resolvedAt}, now()) >= ${openedAtIso}::timestamptz`,
    ))
    .orderBy(asc(dsql`abs(extract(epoch from (${providerIncidents.startedAt} - ${openedAtIso}::timestamptz)))`));

  return rows.map((row) => ({
    dependencyId: row.dependencyId,
    dependencyName: row.dependencyName,
    provider: row.provider,
    incidentId: row.incidentId,
    incidentTitle: row.incidentTitle,
    providerStartedAt: row.providerStartedAt.toISOString(),
    providerResolvedAt: row.providerResolvedAt?.toISOString() ?? null,
    canonicalUrl: row.canonicalUrl ?? row.statusPageUrl,
    matchKind: row.matchKind,
    offsetSeconds: Math.round((row.providerStartedAt.getTime() - monitorIncident.openedAt.getTime()) / 1_000),
  }));
}
