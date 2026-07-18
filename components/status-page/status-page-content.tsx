import Link from "next/link";

import { StatusDot, stateLabels, type MonitorState } from "@/components/monitors/status-dot";
import { TimelineBar, type TimelineBucket } from "@/components/monitors/timeline-bar";
import { RestrictedMarkdown } from "@/lib/markdown/restricted-markdown";
import { formatDuration, formatRelativeTime } from "@/lib/reporting/format";
import {
  formatStatusClock,
  formatStatusTimestamp,
  formatUptimePercent,
  statusAssetUrl,
  timezoneDisplay,
  type TimezoneDisplay,
} from "@/lib/status-page/display";
import {
  monitorReportAnnotations,
  reportBannerTier,
  reportDurationSeconds,
  reportStatusLabels,
  statusReportUrl,
  type PublicOverallState,
  type PublicReportEntry,
  type PublicReportsView,
} from "@/lib/status-page/reports-display";
import type { StatusPageNavLink } from "@/lib/status-page/schema";

import { OverallBanner } from "./overall-banner";
import styles from "./status-page.module.css";

export type StatusPageDisplayConfig = {
  layout: "vertical" | "horizontal";
  theme: "system" | "light" | "dark";
  logoLightImageId: string | null;
  logoDarkImageId: string | null;
  homepageUrl: string | null;
  contactUrl: string | null;
  navLinks: StatusPageNavLink[];
  historyDays: number;
  uptimeDecimals: number;
  timezone: string | null;
  /** Non-null only when the announcement is enabled and has content. */
  announcementMarkdown: string | null;
};

export type PublicStatusData = {
  pageName: string;
  lastUpdatedAt: string;
  overallState: PublicOverallState;
  config: StatusPageDisplayConfig;
  reports: PublicReportsView;
  currentIncidents: Array<{
    id: string;
    monitorName: string;
    openedAt: string;
    elapsedSeconds: number;
    cause: string;
  }>;
  groups: Array<{
    name: string;
    slug: string;
    monitors: Array<{
      id: string;
      name: string;
      state: MonitorState;
      uptime: number | null;
      timeline: TimelineBucket[];
    }>;
  }>;
  recentIncidents: Array<{
    id: string;
    monitorName: string;
    openedAt: string;
    durationSeconds: number;
  }>;
};

/**
 * Theme-appropriate logo. A forced theme renders exactly one variant; the
 * system theme renders both and lets the stylesheet pick via
 * prefers-color-scheme (no client JS). Missing variants fall back to the other.
 */
function PageLogo({ config, pageName }: { config: StatusPageDisplayConfig; pageName: string }) {
  const light = config.logoLightImageId ?? config.logoDarkImageId;
  const dark = config.logoDarkImageId ?? config.logoLightImageId;
  if (!light || !dark) return null;

  const image =
    config.theme === "light" || config.theme === "dark" || light === dark ? (
      // eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route
      <img
        src={statusAssetUrl(config.theme === "dark" ? dark : light)}
        alt={`${pageName} logo`}
        className="h-8 w-auto max-w-[240px] object-contain"
      />
    ) : (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route */}
        <img src={statusAssetUrl(light)} alt={`${pageName} logo`} className={`${styles.logoLight} h-8 w-auto max-w-[240px] object-contain`} />
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route */}
        <img src={statusAssetUrl(dark)} alt="" aria-hidden className={`${styles.logoDark} h-8 w-auto max-w-[240px] object-contain`} />
      </>
    );

  if (config.homepageUrl) {
    return (
      <a href={config.homepageUrl} className="inline-flex shrink-0" aria-label={`${pageName} homepage`}>
        {image}
      </a>
    );
  }
  return <span className="inline-flex shrink-0">{image}</span>;
}

function HeaderNav({ config }: { config: StatusPageDisplayConfig }) {
  if (config.navLinks.length === 0 && !config.contactUrl) return null;
  return (
    <nav aria-label="Status page links" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {config.navLinks.map((link, index) => (
        <a
          key={`${link.url}-${index}`}
          href={link.url}
          className="text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
        >
          {link.label}
        </a>
      ))}
      {config.contactUrl ? (
        <a
          href={config.contactUrl}
          className="inline-flex h-7 items-center rounded-[6px] border border-[var(--border-strong)] px-2.5 text-[13px] font-medium hover:border-[var(--border-hover)]"
        >
          Get in touch
        </a>
      ) : null}
    </nav>
  );
}

/** Card tint per report tier: outage red, degraded amber, maintenance neutral. */
const reportCardTints: Record<"outage" | "degraded" | "maintenance", string> = {
  outage: "border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)]",
  degraded: "border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)]",
  maintenance: "border-[var(--border-strong)] bg-[var(--chip-bg)]",
};

const reportTierDots: Record<"outage" | "degraded" | "maintenance", MonitorState> = {
  outage: "DOWN",
  degraded: "VERIFYING_DOWN",
  maintenance: "PAUSED",
};

function AffectedChips({ report }: { report: PublicReportEntry }) {
  if (report.affected.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Affected services">
      {report.affected.map((entry) => (
        <li
          key={entry.monitorId}
          className="rounded-full border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-0.5 text-xs text-[var(--fg-muted)]"
        >
          {entry.monitorName}
        </li>
      ))}
    </ul>
  );
}

/** Ongoing authored reports, between the overall banner and the auto-incident cards (§3.6). */
function OngoingReports({ data, zone }: { data: PublicStatusData; zone: TimezoneDisplay }) {
  if (data.reports.ongoing.length === 0) return null;
  const now = new Date(data.lastUpdatedAt);
  return (
    <section className="mt-6 space-y-3" aria-labelledby="ongoing-reports-heading">
      <h2 id="ongoing-reports-heading" className="sr-only">
        Ongoing Reports
      </h2>
      {data.reports.ongoing.map((report) => {
        const tier = reportBannerTier(report);
        return (
          <article key={report.id} className={`rounded-xl border p-5 ${reportCardTints[tier]}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot state={reportTierDots[tier]} aria-hidden />
                <h3 className="text-sm font-semibold">
                  <Link href={statusReportUrl(report.id)} className="hover:underline">
                    {report.title}
                  </Link>
                </h3>
              </div>
              <span className="text-xs font-medium text-[var(--fg-muted)]">
                {reportStatusLabels[report.currentStatus]}
              </span>
            </div>
            {report.latestUpdate ? (
              <RestrictedMarkdown
                markdown={report.latestUpdate.markdown}
                className="mt-2 space-y-2 text-[13px] leading-[19px] text-[var(--fg-muted)] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
              />
            ) : null}
            <AffectedChips report={report} />
            <p className="mt-3 text-xs text-[var(--fg-faint)]">
              {report.latestUpdate ? (
                <>
                  Updated{" "}
                  <span className="font-data">
                    {formatRelativeTime(new Date(report.latestUpdate.publishedAt), now, zone.timeZone)}
                  </span>
                  {" · "}
                </>
              ) : null}
              <Link href={statusReportUrl(report.id)} className="hover:text-[var(--fg)] hover:underline">
                View report →
              </Link>
            </p>
          </article>
        );
      })}
    </section>
  );
}

/** Published maintenance windows: upcoming first, then demoted ended windows (§3.6). */
function MaintenanceSchedule({ data, zone }: { data: PublicStatusData; zone: TimezoneDisplay }) {
  const { upcoming, windowEnded } = data.reports;
  if (upcoming.length === 0 && windowEnded.length === 0) return null;
  const window = (report: PublicReportEntry) => (
    <>
      {formatStatusTimestamp(report.startsAt, zone.timeZone)}
      {report.endsAt ? ` – ${formatStatusTimestamp(report.endsAt, zone.timeZone)}` : ""} {zone.short}
    </>
  );
  return (
    <section
      className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
      aria-labelledby="maintenance-heading"
    >
      <h2 id="maintenance-heading" className="px-6 py-4 text-sm font-semibold">
        Scheduled Maintenance
      </h2>
      <ul className="divide-y divide-[var(--border)]" role="list">
        {upcoming.map((report) => (
          <li key={report.id} className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <StatusDot state="PENDING" aria-hidden />
              <Link href={statusReportUrl(report.id)} className="truncate hover:underline">
                {report.title}
              </Link>
              <span className="sr-only">Upcoming maintenance</span>
            </span>
            <span className="font-data text-[var(--fg-muted)]">{window(report)}</span>
          </li>
        ))}
        {windowEnded.map((report) => (
          <li
            key={report.id}
            className="grid gap-1 px-6 py-4 text-[13px] opacity-70 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <StatusDot state="PENDING" aria-hidden />
              <Link href={statusReportUrl(report.id)} className="truncate hover:underline">
                {report.title}
              </Link>
            </span>
            <span className="text-xs text-[var(--fg-muted)]">Window ended</span>
            <span className="font-data text-[var(--fg-muted)]">{window(report)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type RecentHistoryEntry =
  | { kind: "report"; startMs: number; report: PublicReportEntry }
  | { kind: "incident"; startMs: number; incident: PublicStatusData["recentIncidents"][number] };

/**
 * One chronological "Recent Incidents" feed (§3.6): resolved authored reports
 * and un-folded machine incidents interleave by start time, newest first,
 * instead of rendering as two separately sorted blocks.
 */
function mergeRecentHistory(data: PublicStatusData): RecentHistoryEntry[] {
  return [
    ...data.reports.resolved.map<RecentHistoryEntry>((report) => ({
      kind: "report",
      startMs: Date.parse(report.startsAt),
      report,
    })),
    ...data.recentIncidents.map<RecentHistoryEntry>((incident) => ({
      kind: "incident",
      startMs: Date.parse(incident.openedAt),
      incident,
    })),
  ].sort((left, right) => right.startMs - left.startMs);
}

function StatusCard({ data, groupView }: { data: PublicStatusData; groupView: boolean }) {
  if (data.groups.length === 0) {
    return (
      <section
        className="rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
        aria-labelledby="systems-heading"
      >
        <h2 id="systems-heading" className="text-sm font-semibold">
          Systems
        </h2>
        <div className="mt-4 flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
          <StatusDot state="PENDING" aria-hidden />
          <span>No public monitors in this group</span>
        </div>
      </section>
    );
  }

  // "— see report" annotations supplement the machine state dot while a
  // report is ongoing; the dot itself always shows the machine state (§3.6).
  const annotations = monitorReportAnnotations(data.reports.ongoing);

  return (
    <div className="space-y-6" aria-label="System availability">
      {data.groups.map((group) => (
        <section
          key={group.slug}
          className="overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
          aria-labelledby={`group-${group.slug}`}
        >
          <div className="flex items-center justify-between px-6 pb-2 pt-5">
            <h2 id={`group-${group.slug}`} className="text-sm font-semibold">
              {group.name}
            </h2>
            {!groupView ? (
              <Link
                href={`/status/${group.slug}`}
                className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
                aria-label={`View ${group.name} status`}
              >
                View Group
              </Link>
            ) : null}
          </div>
          <div>
            {group.monitors.map((monitor) => {
              const annotation = annotations.get(monitor.id);
              return (
              <div
                key={monitor.id}
                className="grid gap-3 border-t border-[var(--border)] px-6 py-4 sm:grid-cols-[minmax(130px,0.8fr)_minmax(210px,1.4fr)_72px] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot state={monitor.state} aria-hidden />
                  <span className="truncate text-[13px] font-medium">{monitor.name}</span>
                  <span className="sr-only">
                    {stateLabels[monitor.state]}
                    {annotation ? `. ${annotation.label}` : ""}
                  </span>
                  {annotation ? (
                    <span aria-hidden className="shrink-0 whitespace-nowrap text-xs text-[var(--fg-muted)]">
                      {annotation.label}
                    </span>
                  ) : null}
                </div>
                <TimelineBar
                  buckets={monitor.timeline}
                  label={`${monitor.name}, ${data.config.historyDays}-day availability`}
                  className="order-3 sm:order-none"
                />
                <span className="font-data text-right text-[13px]">
                  {formatUptimePercent(monitor.uptime, data.config.uptimeDecimals)}
                </span>
              </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function StatusPageContent({
  data,
  groupView = false,
}: {
  data: PublicStatusData;
  groupView?: boolean;
}) {
  const groupName = groupView ? data.groups[0]?.name : undefined;
  const zone = timezoneDisplay(data.config.timezone, new Date(data.lastUpdatedAt));
  const horizontal = data.config.layout === "horizontal";

  const title = (
    <div>
      <h1 className="text-base font-semibold tracking-[-0.32px]">{data.pageName}</h1>
      {groupName ? <p className="mt-1 text-[13px] text-[var(--fg-muted)]">{groupName}</p> : null}
    </div>
  );

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 pb-16 pt-12 sm:px-6">
      {groupView ? (
        <Link
          href="/status"
          className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
        >
          ← All Systems
        </Link>
      ) : null}

      {horizontal ? (
        <header className="mb-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 items-center gap-4">
              <PageLogo config={data.config} pageName={data.pageName} />
              {title}
            </div>
            <HeaderNav config={data.config} />
          </div>
          <time dateTime={data.lastUpdatedAt} className="font-data block text-xs text-[var(--fg-faint)]">
            Last updated {formatStatusClock(data.lastUpdatedAt, zone.timeZone)} {zone.full}
          </time>
        </header>
      ) : (
        <header className="mb-6 space-y-3">
          <PageLogo config={data.config} pageName={data.pageName} />
          <div className="flex flex-wrap items-end justify-between gap-2">
            {title}
            <time dateTime={data.lastUpdatedAt} className="font-data text-xs text-[var(--fg-faint)]">
              Last updated {formatStatusClock(data.lastUpdatedAt, zone.timeZone)} {zone.full}
            </time>
          </div>
          <HeaderNav config={data.config} />
        </header>
      )}

      {data.config.announcementMarkdown ? (
        <aside
          aria-label="Announcement"
          className="mb-4 rounded-xl border border-[var(--border-strong)] bg-[var(--chip-bg)] p-5"
        >
          <RestrictedMarkdown
            markdown={data.config.announcementMarkdown}
            className="space-y-2 text-[13px] leading-[19px] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
          />
        </aside>
      ) : null}

      <OverallBanner state={data.overallState} />

      <OngoingReports data={data} zone={zone} />

      {data.currentIncidents.length > 0 ? (
        <section className="mt-6 space-y-3" aria-labelledby="current-incidents-heading">
          <h2 id="current-incidents-heading" className="sr-only">
            Current Incidents
          </h2>
          {data.currentIncidents.map((incident) => (
            <article
              key={incident.id}
              className="rounded-xl border border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)] p-5"
            >
              <div className="flex items-center gap-2">
                <StatusDot state="DOWN" aria-hidden />
                <h3 className="text-sm font-semibold">{incident.monitorName}</h3>
              </div>
              <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
                Ongoing since <span className="font-data">{formatStatusTimestamp(incident.openedAt, zone.timeZone)} {zone.short}</span>
                {" · "}
                <span className="font-data">{formatDuration(incident.elapsedSeconds)}</span> elapsed
              </p>
              <p className="font-data mt-2 break-words text-[13px] text-[var(--down-text)]">
                {incident.cause || "Availability check failed"}
              </p>
            </article>
          ))}
        </section>
      ) : null}

      <div className="mt-6">
        <StatusCard data={data} groupView={groupView} />
      </div>

      <MaintenanceSchedule data={data} zone={zone} />

      <section
        className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
        aria-labelledby="recent-incidents-heading"
      >
        <h2 id="recent-incidents-heading" className="px-6 py-4 text-sm font-semibold">
          Recent Incidents
        </h2>
        {data.reports.resolved.length > 0 || data.recentIncidents.length > 0 ? (
          <ul className="divide-y divide-[var(--border)]" role="list">
            {/* Authored resolved reports (snapshotted names) and the machine
                incidents not folded into a report, merged into one list sorted
                by start time descending (§3.6). */}
            {mergeRecentHistory(data).map((entry) =>
              entry.kind === "report" ? (
                <li
                  key={`report-${entry.report.id}`}
                  className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <StatusDot state="PENDING" aria-hidden />
                    <Link href={statusReportUrl(entry.report.id)} className="truncate hover:underline">
                      {entry.report.title}
                    </Link>
                    <span className="sr-only">Resolved report</span>
                  </span>
                  <time dateTime={entry.report.startsAt} className="font-data text-[var(--fg-muted)]">
                    {formatStatusTimestamp(entry.report.startsAt, zone.timeZone)} {zone.short}
                  </time>
                  <span className="font-data sm:min-w-16 sm:text-right">
                    {formatDuration(reportDurationSeconds(entry.report))}
                  </span>
                </li>
              ) : (
                <li
                  key={`incident-${entry.incident.id}`}
                  className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <StatusDot state="PENDING" aria-hidden />
                    <span className="truncate">{entry.incident.monitorName}</span>
                    <span className="sr-only">Resolved</span>
                  </span>
                  <time
                    dateTime={entry.incident.openedAt}
                    className="font-data text-[var(--fg-muted)]"
                  >
                    {formatStatusTimestamp(entry.incident.openedAt, zone.timeZone)} {zone.short}
                  </time>
                  <span className="font-data sm:min-w-16 sm:text-right">
                    {formatDuration(entry.incident.durationSeconds)}
                  </span>
                </li>
              ),
            )}
          </ul>
        ) : (
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-6 py-5 text-[13px] text-[var(--fg-muted)]">
            <StatusDot state="UP" aria-hidden />
            <span>No recent incidents</span>
          </div>
        )}
      </section>
    </main>
  );
}
