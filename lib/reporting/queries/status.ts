import { cache } from "react";

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { getImage } from "@/lib/api/images";
import { getStatusPageConfig, StatusPageConfigError } from "@/lib/api/status-page-config";
import {
  getPublicReports,
  getStatusReport,
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
  filterReportsForGroup,
  promotedIncidentIds,
} from "@/lib/status-page/reports-display";
import type { StatusPageConfigDocument } from "@/lib/status-page/schema";

import { buildRollupTimeline, statusGroupSlug, summarizeRollupCoverage } from "./timeline";

/**
 * Recent resolved-incidents history is overfetched by this bounded multiple
 * rather than the eventual display count (10, RECENT_INCIDENTS_DISPLAY_LIMIT
 * below): both the minIncidentSeconds duration filter and the promoted-origin
 * exclusion run AFTER this query returns (finding: applying a LIMIT 10 before
 * either filter could empty an otherwise-populated history down to a
 * handful of short/promoted rows). The promoted-origin id set can't be
 * folded into this query's SQL because it's only known once getPublicReports
 * resolves — which this query runs IN PARALLEL WITH via the outer
 * Promise.all, not before — so SQL-side exclusion would require serializing
 * the two fan-outs. 60 is generous headroom for any realistic mix of
 * short-duration/promoted incidents while staying far short of an unbounded
 * scan.
 */
const RECENT_INCIDENTS_FETCH_LIMIT = 60;
const RECENT_INCIDENTS_DISPLAY_LIMIT = 10;

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
 * degrades to the historical defaults instead of failing the public page — and
 * so does an unreachable database (§ build on Preview with no DATABASE_URL,
 * or a runtime DB outage): both are infra-class conditions the public page
 * must survive, never app bugs to surface.
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

/** Favicon inlined as a data: URI in the ISR'd head (§2.3); null when unset or the database is unavailable. */
export const getStatusFaviconDataUri = cache(async (): Promise<string | null> => {
  const config = await getStatusPageDisplayConfig();
  if (!config.faviconImageId) return null;
  try {
    const image = await getImage(config.faviconImageId);
    if (!image || image.kind !== "favicon") return null;
    return imageDataUri(image.mimeType, image.bytes);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return null;
    throw error;
  }
});

/**
 * Degraded payload for when the database is unreachable or not yet migrated
 * (§ build on Preview with no DATABASE_URL, or a runtime DB outage): the
 * public page must render a neutral "temporarily unavailable" shell instead
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
  // historyDays drives the fetch window, not just the display (§2.3).
  const earliest = historyWindowStart(config.historyDays, completedDay);
  const monitors = await db.select({
    id: monitorRegistry.id,
    name: monitorRegistry.name,
    groupName: monitorRegistry.groupName,
    state: monitorState.state,
  }).from(monitorRegistry)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitorRegistry.id))
    .where(and(eq(monitorRegistry.enabled, true), isNull(monitorRegistry.archivedAt)))
    .limit(100);
  const visible = group
    ? monitors.filter((monitor) => statusGroupSlug(monitor.groupName ?? "Other") === group)
    : monitors;
  if (group && visible.length === 0) return null;

  const ids = visible.map((monitor) => monitor.id);
  // Group pages scope query 1 of getPublicReports to this group's monitors so
  // the resolved-history LIMIT is applied AFTER group filtering — otherwise a
  // global top-10 resolved list can starve a group's history even though
  // older relevant resolved reports exist. The root page (no `group`) stays
  // unfiltered. filterReportsForGroup below still runs as a defense-in-depth
  // pass over whatever this returns.
  const publicReportsFilter = group
    ? { monitorIds: ids, groupNames: [...new Set(visible.map((monitor) => monitor.groupName ?? "Other"))] }
    : undefined;
  // One parallel fan-out per revalidation: the three monitor-scoped queries
  // plus the batched public-reports read (itself exactly 3 queries, §3.2).
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
      .limit(100),
    db.select({
      id: incidents.id,
      monitorName: monitorRegistry.name,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
    }).from(incidents)
      .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
      .where(and(inArray(incidents.monitorId, ids), isNotNull(incidents.resolvedAt)))
      .orderBy(desc(incidents.resolvedAt))
      .limit(RECENT_INCIDENTS_FETCH_LIMIT),
    ]),
  ]);

  // Group filtering (§3.6): a report appears on /status/[group] iff it affects
  // a monitor in that group, matched by monitor id or snapshotted group name.
  const reports: PublicReports = group
    ? {
        ongoing: filterReportsForGroup(publicReports.ongoing, visible),
        upcoming: filterReportsForGroup(publicReports.upcoming, visible),
        windowEnded: filterReportsForGroup(publicReports.windowEnded, visible),
        resolved: filterReportsForGroup(publicReports.resolved, visible),
      }
    : publicReports;
  // Ongoing dedupe: an ongoing auto-incident card is suppressed when an
  // ongoing published report was promoted from it. History folding drops
  // machine incidents represented by ANY published report entry. Both sets use
  // the GROUP-FILTERED report lists: on a group page an incident is only
  // folded when its promoted report actually renders on that page — otherwise
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
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => ({
      name,
      slug: statusGroupSlug(name),
      monitors: entries.sort((left, right) => left.name.localeCompare(right.name)).map((monitor) => {
        const rows = rollups.filter((rollup) => rollup.monitorId === monitor.id);
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
  // Machine states derive the classic tiers; published ongoing reports add the
  // degraded/maintenance/outage tiers. The reddest wins (§3.6).
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
    // The floor only applies to this resolved-history list — never to ongoing
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
    if (!isDatabaseUnavailableError(error)) throw error;
    return degradedPublicStatus();
  }
});

/**
 * Single published report for the permalink page (§3.6). Drafts and unknown
 * ids resolve to null → notFound(). Request-deduped so page + generateMetadata
 * share the read within one revalidation.
 *
 * A `null` return means "not found" (drafts, unknown ids) and should 404; the
 * distinct `"unavailable"` sentinel means the database itself is unreachable
 * or not yet migrated, and the page should render a degraded message instead
 * of 404ing on a report that may well exist.
 */
export const getPublicReportDetail = cache(
  async (reportId: string): Promise<StatusReportData | null | "unavailable"> => {
    try {
      const report = await getStatusReport(reportId);
      if (!report.publishedAt) return null;
      return report;
    } catch (error) {
      if (error instanceof StatusReportError && error.code === "REPORT_NOT_FOUND") return null;
      if (isDatabaseUnavailableError(error)) return "unavailable";
      throw error;
    }
  },
);
