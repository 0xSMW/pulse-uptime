import { cache } from "react";

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { findImage } from "@/lib/api/images";
import { getStatusPageConfig, StatusPageConfigError } from "@/lib/api/status-page-config";
import {
  getPublicReports,
  requireStatusReport,
  StatusReportError,
  type PublicReports,
  type StatusReportData,
} from "@/lib/api/status-reports";
import { db } from "@/lib/db/client";
import { isDatabaseUnavailableError } from "@/lib/db/errors";
import { incidents, metricRollups, monitorRegistry, monitorState } from "@/lib/db/schema";
import {
  defaultStatusPageDocument,
  displayTimelineBuckets,
  filterShortResolvedIncidents,
  historyWindowStart,
  imageDataUri,
} from "@/lib/status-page/display";
import {
  deriveOverallState,
  excludePromotedIncidents,
  promotedIncidentIds,
  type PublicReportEntry,
} from "@/lib/status-page/reports-display";
import type { StatusPageConfigDocument } from "@/lib/status-page/schema";

import { rollupsSinceActivation } from "./first-run";
import { buildRollupTimeline, statusGroupSlug, summarizeRollupCoverage } from "./timeline";

/**
 * Overfetch multiple for resolved-incident history, not the eventual display
 * count (10, RECENT_INCIDENTS_DISPLAY_LIMIT below): the minIncidentSeconds
 * duration filter and the promoted-origin exclusion both run after this
 * query returns, so the LIMIT must clear both filters, not just size to the
 * display count, or a LIMIT 10 applied first could empty an otherwise
 * populated history down to a handful of short/promoted rows. The
 * promoted-origin id set can't be folded into this query's SQL because it's
 * only known once getPublicReports resolves, and that call runs in parallel
 * with this one via the outer Promise.all, not before it, so SQL-side
 * exclusion would require serializing the two fan-outs. 60 gives headroom
 * for any realistic mix of short-duration/promoted incidents while staying
 * far short of an unbounded scan.
 */
const RECENT_INCIDENTS_FETCH_LIMIT = 60;
const RECENT_INCIDENTS_DISPLAY_LIMIT = 10;

/**
 * Current (ongoing) active-incident overfetch: excludePromotedIncidents runs
 * after this query, so the LIMIT must clear that exclusion too, not just
 * size to the eventual display count. Here there is no display cap, every
 * unpromoted active incident is shown. With more than 100 simultaneously
 * active incidents whose newest are promoted into ongoing reports, a bare
 * LIMIT 100 would fill entirely with rows that then get excluded, dropping
 * older still-active unpromoted incidents from the page even though they
 * qualify. Unlike the resolved-history overfetch above, currentIncidents has
 * no trailing `.slice()`. Every row this query returns after exclusion is
 * displayed, so the fix is simply a generous query LIMIT, not an
 * overfetch-then-slice pair. 500 is far beyond any realistic simultaneous
 * active-incident count while staying bounded. The tradeoff is the same
 * pathological case as the resolved-history fetch: if active-incident volume
 * (promoted + unpromoted) ever exceeds this bound, the oldest active
 * incidents past it would still be dropped, but that requires an outage of a
 * scale this dashboard isn't designed to display anyway.
 */
const CURRENT_INCIDENTS_FETCH_LIMIT = 500;

/**
 * A report belongs on /status/[group] iff it affects that group, matched by a
 * currently visible monitor id or by the SLUG of the snapshotted group name.
 * Slug matching (not exact-name matching against visible monitors) is what
 * keeps a report reachable when every monitor it affected has since been
 * archived: the affected rows still carry the group-name snapshot, and its
 * slug is exactly what the URL segment encodes. Null snapshot group names
 * collapse to the "Other" bucket exactly as the page groups live monitors.
 */
function filterReportsForGroupSlug<T extends Pick<PublicReportEntry, "affected">>(
  reports: readonly T[],
  slug: string,
  visibleMonitorIds: ReadonlySet<string>,
): T[] {
  return reports.filter((report) =>
    report.affected.some(
      (entry) =>
        visibleMonitorIds.has(entry.monitorId) ||
        statusGroupSlug(entry.groupName ?? "Other") === slug,
    ),
  );
}

// Groups rows by monitor ID while preserving input order.
export function groupByMonitorId<T extends { monitorId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.monitorId);
    if (bucket) bucket.push(row);
    else grouped.set(row.monitorId, [row]);
  }
  return grouped;
}

function failureLabel(statusCode: number | null): string {
  if (statusCode !== null) return `HTTP ${statusCode}`;
  // Checker codes can include infrastructure detail. Public pages use a stable,
  // actionable-safe label while the authenticated incident view retains the code.
  return "Availability check failed";
}

/**
 * The status page configuration, request-deduped so the layout (theme,
 * customCss/customHead, analytics), the pages, and generateMetadata share one
 * single-row SELECT per revalidation. A missing row (migrations not run yet)
 * degrades to the historical defaults instead of failing the public page,
 * and so does an unreachable database (for example, building on Preview
 * with no DATABASE_URL, or a runtime DB outage): both are infra-class
 * conditions the public page must survive, never app bugs to surface.
 */
export const getStatusPageDisplayConfig = cache(
  async (): Promise<StatusPageConfigDocument> => {
    try {
      const { data } = await getStatusPageConfig();
      const { updatedAt: _updatedAt, ...document } = data;
      void _updatedAt;
      return document;
    } catch (error) {
      if (error instanceof StatusPageConfigError && error.code === "CONFIG_UNAVAILABLE") {
        return defaultStatusPageDocument();
      }
      if (isDatabaseUnavailableError(error)) return defaultStatusPageDocument();
      throw error;
    }
  },
);

/** Favicon inlined as a data: URI in the ISR'd head. Null when unset or the database is unavailable. */
export const getStatusFaviconDataUri = cache(async (): Promise<string | null> => {
  const config = await getStatusPageDisplayConfig();
  if (!config.faviconImageId) return null;
  try {
    const image = await findImage(config.faviconImageId);
    if (!image || image.kind !== "favicon") return null;
    return imageDataUri(image.mimeType, image.bytes);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return null;
    throw error;
  }
});

/**
 * Degraded payload for when the database is unreachable or not yet migrated
 * (for example, building on Preview with no DATABASE_URL, or a runtime DB
 * outage): the public page must render a neutral "temporarily unavailable" shell instead
 * of throwing (an uptime status page should degrade, not 500, during its own
 * DB outage). `config` falls back to the historical defaults since the real
 * document can't be read either.
 */
function degradedPublicStatus() {
  const config = defaultStatusPageDocument();
  return {
    pageName: config.name,
    lastUpdatedAt: new Date().toISOString(),
    overallState: "empty" as const,
    unavailable: true as const,
    config: {
      layout: config.layout,
      theme: config.theme,
      logoLightImageId: config.logoLightImageId,
      logoDarkImageId: config.logoDarkImageId,
      homepageUrl: config.homepageUrl,
      contactUrl: config.contactUrl,
      navLinks: config.navLinks,
      historyDays: config.historyDays,
      uptimeDecimals: config.uptimeDecimals,
      timezone: config.timezone,
      announcementMarkdown: null,
    },
    reports: { ongoing: [], upcoming: [], windowEnded: [], resolved: [] },
    currentIncidents: [],
    groups: [],
    recentIncidents: [],
  };
}

async function loadPublicStatus(group?: string) {
  const config = await getStatusPageDisplayConfig();
  const now = new Date();
  const completedDay = new Date(now);
  completedDay.setUTCHours(0, 0, 0, 0);
  // historyDays drives the fetch window, not just the display.
  const earliest = historyWindowStart(config.historyDays, completedDay);
  const monitors = await db.select({
    id: monitorRegistry.id,
    name: monitorRegistry.name,
    groupName: monitorRegistry.groupName,
    state: monitorState.state,
    activatedAt: monitorState.activatedAt,
  }).from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(and(eq(monitorRegistry.enabled, true), isNull(monitorRegistry.archivedAt)))
    .limit(100);
  const visible = group
    ? monitors.filter((monitor) => statusGroupSlug(monitor.groupName ?? "Other") === group)
    : monitors;

  const ids = visible.map((monitor) => monitor.id);
  // Every group page scopes query 1 of getPublicReports to this group, with
  // or without visible monitors, so the unresolved and resolved row caps are
  // applied after group scoping. An unscoped fetch lets unrelated reports
  // fill the caps and starve a group whose only reports are older, which
  // would 404 an archived-only group that still has published history. The
  // slug is passed down (never live group names) because getPublicReports
  // resolves it back to the exact snapshotted group names, keeping a report
  // matched even when the snapshot spells the group differently (accents,
  // case, punctuation) than the live monitors do. The root page (no `group`)
  // stays unfiltered so its caps stay global. filterReportsForGroupSlug
  // below still runs as a defense-in-depth pass over whatever this returns.
  const publicReportsFilter = group ? { monitorIds: ids, groupSlug: group } : undefined;
  // One parallel fan-out per revalidation: the three monitor-scoped queries
  // plus the batched public-reports read (itself exactly 3 queries).
  const [publicReports, [rollups, current, recent]] = await Promise.all([
    getPublicReports(undefined, publicReportsFilter),
    ids.length === 0 ? Promise.resolve<[never[], never[], never[]]>([[], [], []]) : Promise.all([
    db.select({
      monitorId: metricRollups.monitorId,
      bucketStart: metricRollups.bucketStart,
      expectedChecks: metricRollups.expectedChecks,
      completedChecks: metricRollups.completedChecks,
      successfulChecks: metricRollups.successfulChecks,
      failedChecks: metricRollups.failedChecks,
      unknownChecks: metricRollups.unknownChecks,
      downtimeSeconds: metricRollups.downtimeSeconds,
    }).from(metricRollups)
      .where(and(
        inArray(metricRollups.monitorId, ids),
        eq(metricRollups.resolution, "day"),
        gte(metricRollups.bucketStart, earliest),
        lt(metricRollups.bucketStart, completedDay),
      ))
      .orderBy(metricRollups.bucketStart)
      .limit(9_000),
    db.select({
      id: incidents.id,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      openingStatusCode: incidents.openingStatusCode,
    }).from(incidents)
      .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
      .where(and(inArray(incidents.monitorId, ids), isNull(incidents.resolvedAt)))
      .orderBy(desc(incidents.openedAt))
      .limit(CURRENT_INCIDENTS_FETCH_LIMIT),
    db.select({
      id: incidents.id,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
    }).from(incidents)
      .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
      // Resolved incidents opened before their monitor activated are setup-phase
      // failures, not real downtime, so the activation gate drops them from
      // public history. A null activatedAt fails the comparison, so a monitor
      // that never activated surfaces no resolved incidents. Ongoing incidents
      // are exempt from this gate below, since a backfilled activatedAt is at or
      // before their opened_at and must never hide a live outage.
      .innerJoin(monitorState, eq(monitorState.monitorId, incidents.monitorId))
      .where(and(
        inArray(incidents.monitorId, ids),
        isNotNull(incidents.resolvedAt),
        gte(incidents.openedAt, monitorState.activatedAt),
      ))
      .orderBy(desc(incidents.resolvedAt))
      .limit(RECENT_INCIDENTS_FETCH_LIMIT),
    ]),
  ]);

  // Group filtering: a report appears on /status/[group] iff it affects
  // a monitor in that group, matched by visible monitor id or by the slug of
  // the snapshotted group name (see filterReportsForGroupSlug).
  const visibleIds = new Set(ids);
  const reports: PublicReports = group
    ? {
        ongoing: filterReportsForGroupSlug(publicReports.ongoing, group, visibleIds),
        upcoming: filterReportsForGroupSlug(publicReports.upcoming, group, visibleIds),
        windowEnded: filterReportsForGroupSlug(publicReports.windowEnded, group, visibleIds),
        resolved: filterReportsForGroupSlug(publicReports.resolved, group, visibleIds),
      }
    : publicReports;
  // A group URL is absent (null, the page 404s) only when it has NEITHER
  // visible monitors NOR any published report scoped to it. A group whose
  // monitors were all archived but that still has published reports (their
  // affected rows snapshot the group name) must keep rendering those reports,
  // so this decision can only be made after the report fetch, never from the
  // monitor query alone.
  if (group && visible.length === 0) {
    const hasReports =
      reports.ongoing.length > 0 ||
      reports.upcoming.length > 0 ||
      reports.windowEnded.length > 0 ||
      reports.resolved.length > 0;
    if (!hasReports) return null;
  }
  // Ongoing dedupe: an ongoing auto-incident card is suppressed when an
  // ongoing published report was promoted from it. History folding drops
  // machine incidents represented by ANY published report entry. Both sets use
  // the GROUP-FILTERED report lists: on a group page an incident is only
  // folded when its promoted report actually renders on that page. Otherwise
  // suppressing it would hide an active outage (or its history) entirely.
  const ongoingPromoted = promotedIncidentIds(reports.ongoing);
  const historyPromoted = promotedIncidentIds([
    ...reports.ongoing,
    ...reports.upcoming,
    ...reports.windowEnded,
    ...reports.resolved,
  ]);

  const grouped = new Map<string, typeof visible>();
  for (const monitor of visible) {
    const name = monitor.groupName ?? "Other";
    grouped.set(name, [...(grouped.get(name) ?? []), monitor]);
  }
  const rollupsByMonitor = groupByMonitorId(rollups);

  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => ({
      name,
      slug: statusGroupSlug(name),
      monitors: entries.sort((left, right) => left.name.localeCompare(right.name)).map((monitor) => {
        // Public uptime and history count only buckets at or after activation,
        // the same exclusive bucket-start gate the dashboard uses, so setup
        // failures before the first success never read as public downtime. A
        // never-activated monitor has no observed data, so its uptime is null
        // and its timeline is all no-data, never down.
        const rows = rollupsSinceActivation(rollupsByMonitor.get(monitor.id) ?? [], monitor.activatedAt ?? null);
        const summary = summarizeRollupCoverage(rows);
        return {
          id: monitor.id,
          name: monitor.name,
          state: monitor.state === "ARCHIVED" || monitor.state === null ? "PENDING" as const : monitor.state,
          uptime: summary.uptime,
          coverage: summary.coverage,
          timeline: displayTimelineBuckets(
            buildRollupTimeline(rows, config.historyDays, config.historyDays * 86_400_000, completedDay),
            config.unknownAsOperational,
          ),
        };
      }),
    }));
  const states = visible.map((monitor) => monitor.state ?? "PENDING");
  // Machine states derive the classic tiers. Published ongoing reports add the
  // degraded/maintenance/outage tiers. The reddest wins.
  const overallState = deriveOverallState(states, reports.ongoing);
  return {
    pageName: config.name,
    lastUpdatedAt: now.toISOString(),
    overallState,
    unavailable: false,
    config: {
      layout: config.layout,
      theme: config.theme,
      logoLightImageId: config.logoLightImageId,
      logoDarkImageId: config.logoDarkImageId,
      homepageUrl: config.homepageUrl,
      contactUrl: config.contactUrl,
      navLinks: config.navLinks,
      historyDays: config.historyDays,
      uptimeDecimals: config.uptimeDecimals,
      timezone: config.timezone,
      announcementMarkdown:
        config.announcementEnabled && config.announcementMarkdown?.trim()
          ? config.announcementMarkdown
          : null,
    },
    reports,
    currentIncidents: excludePromotedIncidents(current, ongoingPromoted).map((incident) => ({
      id: incident.id,
      monitorName: incident.monitorName,
      openedAt: incident.openedAt.toISOString(),
      elapsedSeconds: Math.max(0, Math.floor((now.getTime() - incident.openedAt.getTime()) / 1_000)),
      cause: failureLabel(incident.openingStatusCode),
    })),
    groups,
    // The floor only applies to this resolved-history list, never to ongoing
    // incidents (the banner would contradict itself) and never to timelines.
    // Both filters run over the RECENT_INCIDENTS_FETCH_LIMIT-row overfetch
    // (see the query above) before the final slice down to the display
    // count, so a short-duration or promoted row near the top of the fetch
    // can never empty out otherwise-visible older history.
    recentIncidents: filterShortResolvedIncidents(
      excludePromotedIncidents(recent, historyPromoted).map((incident) => ({
        id: incident.id,
        monitorName: incident.monitorName,
        openedAt: incident.openedAt.toISOString(),
        // Always non-null here: query 3 above filters isNotNull(resolvedAt).
        // The `?? now` fallback only satisfies the nullable column type.
        resolvedAt: (incident.resolvedAt ?? now).toISOString(),
        durationSeconds: Math.max(0, Math.floor(((incident.resolvedAt?.getTime() ?? now.getTime()) - incident.openedAt.getTime()) / 1_000)),
      })),
      config.minIncidentSeconds,
    ).slice(0, RECENT_INCIDENTS_DISPLAY_LIMIT),
  };
}

export const getPublicStatus = cache(async (group?: string) => {
  try {
    return await loadPublicStatus(group);
  } catch (error) {
    // Infra-class failures (unreachable or unmigrated database) degrade to
    // the unavailable shell so ISR builds and the public page survive their
    // own provider's outage. Application bugs still surface: degrading them
    // too would hide real regressions behind a healthy-looking page.
    if (!isDatabaseUnavailableError(error)) throw error;
    return degradedPublicStatus();
  }
});

/**
 * Single published report for the permalink page. Drafts and unknown
 * ids resolve to null → notFound(). Request-deduped so page + generateMetadata
 * share the read within one revalidation.
 *
 * A `null` return means "not found" (drafts, unknown ids) and should 404. The
 * distinct `"unavailable"` sentinel means the database itself is unreachable
 * or not yet migrated, and the page should render a degraded message instead
 * of 404ing on a report that may well exist.
 */
export const getPublicReportDetail = cache(
  async (reportId: string): Promise<StatusReportData | null | "unavailable"> => {
    try {
      const report = await requireStatusReport(reportId);
      if (!report.publishedAt) return null;
      return report;
    } catch (error) {
      if (error instanceof StatusReportError && error.code === "REPORT_NOT_FOUND") return null;
      if (isDatabaseUnavailableError(error)) return "unavailable";
      throw error;
    }
  },
);
