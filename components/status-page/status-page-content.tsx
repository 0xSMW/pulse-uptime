import Link from "next/link"

import {
  type MonitorState,
  StatusDot,
  stateLabels,
} from "@/components/monitors/status-dot"
import {
  TimelineBar,
  type TimelineBucket,
} from "@/components/monitors/timeline-bar"
import { RestrictedMarkdown } from "@/lib/markdown/restricted-markdown"
import { formatDuration, formatRelativeTime } from "@/lib/reporting/format"
import {
  formatStatusClock,
  formatStatusTimestamp,
  formatUptimePercent,
  statusAssetUrl,
  type TimezoneDisplay,
  timezoneDisplay,
  timezoneOffsetLabel,
} from "@/lib/status-page/display"
import {
  monitorReportAnnotations,
  type PublicOverallState,
  type PublicReportEntry,
  type PublicReportsView,
  reportBannerTier,
  reportDurationSeconds,
  reportStatusLabels,
  statusReportUrl,
} from "@/lib/status-page/reports-display"
import type { StatusPageNavLink } from "@/lib/status-page/schema"

import { OverallBanner } from "./overall-banner"
import styles from "./status-page.module.css"
import { StatusUnavailableNotice } from "./status-unavailable-notice"

export interface StatusPageDisplayConfig {
  layout: "vertical" | "horizontal"
  theme: "system" | "light" | "dark"
  logoLightImageId: string | null
  logoDarkImageId: string | null
  homepageUrl: string | null
  contactUrl: string | null
  navLinks: StatusPageNavLink[]
  historyDays: number
  uptimeDecimals: number
  timezone: string | null
  /** Non-null only when the announcement is enabled and has content. */
  announcementMarkdown: string | null
}

export interface PublicStatusData {
  pageName: string
  lastUpdatedAt: string
  overallState: PublicOverallState
  /** True when the database was unreachable or not yet migrated. Every other field is a degraded placeholder. */
  unavailable: boolean
  config: StatusPageDisplayConfig
  reports: PublicReportsView
  currentIncidents: Array<{
    id: string
    monitorName: string
    openedAt: string
    elapsedSeconds: number
    cause: string
  }>
  groups: Array<{
    name: string
    slug: string
    monitors: Array<{
      id: string
      name: string
      state: MonitorState
      uptime: number | null
      timeline: TimelineBucket[]
    }>
  }>
  recentIncidents: Array<{
    id: string
    monitorName: string
    openedAt: string
    resolvedAt: string
    durationSeconds: number
  }>
}

/**
 * Theme-appropriate logo. A forced theme renders exactly one variant. The
 * system theme renders both and lets the stylesheet pick via
 * prefers-color-scheme (no client JS). Missing variants fall back to the other.
 */
function PageLogo({
  config,
  pageName,
}: {
  config: StatusPageDisplayConfig
  pageName: string
}) {
  const light = config.logoLightImageId ?? config.logoDarkImageId
  const dark = config.logoDarkImageId ?? config.logoLightImageId
  if (!(light && dark)) {
    return null
  }

  const image =
    config.theme === "light" || config.theme === "dark" || light === dark ? (
      // eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route
      // biome-ignore lint/correctness/useImageSize: uploaded logo of unknown intrinsic size, css fixes height and width scales by aspect
      <img
        alt={`${pageName} logo`}
        className="h-8 w-auto max-w-[240px] object-contain"
        src={statusAssetUrl(config.theme === "dark" ? dark : light)}
      />
    ) : (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route */}
        {/* biome-ignore lint/correctness/useImageSize: uploaded logo of unknown intrinsic size, css fixes height and width scales by aspect */}
        <img
          alt={`${pageName} logo`}
          className={`${styles.logoLight} h-8 w-auto max-w-[240px] object-contain`}
          src={statusAssetUrl(light)}
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic uploaded bytes served from the CDN-cached asset route */}
        {/* biome-ignore lint/correctness/useImageSize: uploaded logo of unknown intrinsic size, css fixes height and width scales by aspect */}
        <img
          alt=""
          aria-hidden
          className={`${styles.logoDark} h-8 w-auto max-w-[240px] object-contain`}
          src={statusAssetUrl(dark)}
        />
      </>
    )

  if (config.homepageUrl) {
    return (
      <a
        aria-label={`${pageName} homepage`}
        className="inline-flex shrink-0"
        href={config.homepageUrl}
      >
        {image}
      </a>
    )
  }
  return <span className="inline-flex shrink-0">{image}</span>
}

function HeaderNav({ config }: { config: StatusPageDisplayConfig }) {
  if (config.navLinks.length === 0 && !config.contactUrl) {
    return null
  }
  return (
    <nav
      aria-label="Status page links"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      {config.navLinks.map((link, index) => (
        <a
          className="text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
          href={link.url}
          // biome-ignore lint/suspicious/noArrayIndexKey: nav link urls may repeat, index disambiguates a non-reordering list
          key={`${link.url}-${index}`}
        >
          {link.label}
        </a>
      ))}
      {config.contactUrl ? (
        <a
          className="inline-flex h-7 items-center rounded-[6px] border border-[var(--border-strong)] px-2.5 font-medium text-[13px] hover:border-[var(--border-hover)]"
          href={config.contactUrl}
        >
          Get in touch
        </a>
      ) : null}
    </nav>
  )
}

/** Card tint per report tier: outage red, degraded amber, maintenance neutral. */
const reportCardTints: Record<"outage" | "degraded" | "maintenance", string> = {
  outage:
    "border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)]",
  degraded:
    "border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)]",
  maintenance: "border-[var(--border-strong)] bg-[var(--chip-bg)]",
}

const reportTierDots: Record<
  "outage" | "degraded" | "maintenance",
  MonitorState
> = {
  outage: "DOWN",
  degraded: "VERIFYING_DOWN",
  maintenance: "PAUSED",
}

function AffectedChips({ report }: { report: PublicReportEntry }) {
  if (report.affected.length === 0) {
    return null
  }
  return (
    <ul aria-label="Affected services" className="mt-3 flex flex-wrap gap-1.5">
      {report.affected.map((entry) => (
        <li
          className="rounded-full border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-0.5 text-[var(--fg-muted)] text-xs"
          key={entry.monitorId}
        >
          {entry.monitorName}
        </li>
      ))}
    </ul>
  )
}

/** Ongoing authored reports, between the overall banner and the auto-incident cards. */
function OngoingReports({
  data,
  zone,
}: {
  data: PublicStatusData
  zone: TimezoneDisplay
}) {
  if (data.reports.ongoing.length === 0) {
    return null
  }
  const now = new Date(data.lastUpdatedAt)
  return (
    <section
      aria-labelledby="ongoing-reports-heading"
      className="mt-6 space-y-3"
    >
      <h2 className="sr-only" id="ongoing-reports-heading">
        Ongoing Reports
      </h2>
      {data.reports.ongoing.map((report) => {
        const tier = reportBannerTier(report)
        return (
          <article
            className={`rounded-xl border p-5 ${reportCardTints[tier]}`}
            key={report.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot aria-hidden state={reportTierDots[tier]} />
                <h3 className="font-semibold text-sm">
                  <Link
                    className="transition-opacity duration-150 hover:opacity-70"
                    href={statusReportUrl(report.id)}
                  >
                    {report.title}
                  </Link>
                </h3>
              </div>
              <span className="font-medium text-[var(--fg-muted)] text-xs">
                {reportStatusLabels[report.currentStatus]}
              </span>
            </div>
            {report.latestUpdate ? (
              <RestrictedMarkdown
                className="mt-2 space-y-2 text-[13px] text-[var(--fg-muted)] leading-[19px] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
                markdown={report.latestUpdate.markdown}
              />
            ) : null}
            <AffectedChips report={report} />
            <p className="mt-3 text-[var(--fg-faint)] text-xs">
              {report.latestUpdate ? (
                <>
                  Updated{" "}
                  <span className="font-data">
                    {formatRelativeTime(
                      new Date(report.latestUpdate.publishedAt),
                      now,
                      zone.timeZone
                    )}
                  </span>
                  {" · "}
                </>
              ) : null}
              <Link
                className="transition-colors duration-150 hover:text-[var(--fg)]"
                href={statusReportUrl(report.id)}
              >
                View report →
              </Link>
            </p>
          </article>
        )
      })}
    </section>
  )
}

/**
 * Published upcoming/ended-window reports: upcoming first, then demoted
 * windows (demoted after their window ends). Almost always maintenance, but
 * a future-dated incident report can land here too, so the heading and
 * per-row label generalize instead of always saying "maintenance".
 */
function MaintenanceSchedule({
  data,
  zone,
}: {
  data: PublicStatusData
  zone: TimezoneDisplay
}) {
  const { upcoming, windowEnded } = data.reports
  if (upcoming.length === 0 && windowEnded.length === 0) {
    return null
  }
  const allMaintenance = [...upcoming, ...windowEnded].every(
    (report) => report.type === "maintenance"
  )
  const heading = allMaintenance ? "Scheduled Maintenance" : "Scheduled Reports"
  // Each timestamp gets its OWN offset label: a single page-level offset
  // reused across rows would be wrong for rows on the other side of a DST
  // boundary. startsAt and endsAt can even differ from each other when a
  // long window straddles the transition.
  const window = (report: PublicReportEntry) => (
    <>
      {formatStatusTimestamp(report.startsAt, zone.timeZone)}{" "}
      {timezoneOffsetLabel(data.config.timezone, new Date(report.startsAt))}
      {report.endsAt ? (
        <>
          {" "}
          – {formatStatusTimestamp(report.endsAt, zone.timeZone)}{" "}
          {timezoneOffsetLabel(data.config.timezone, new Date(report.endsAt))}
        </>
      ) : null}
    </>
  )
  return (
    <section
      aria-labelledby="maintenance-heading"
      className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
    >
      <h2 className="px-6 py-4 font-semibold text-sm" id="maintenance-heading">
        {heading}
      </h2>
      <ul className="divide-y divide-[var(--border)]">
        {upcoming.map((report) => (
          <li
            className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6"
            key={report.id}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <StatusDot aria-hidden state="PENDING" />
              <Link
                className="truncate transition-opacity duration-150 hover:opacity-70"
                href={statusReportUrl(report.id)}
              >
                {report.title}
              </Link>
              <span className="sr-only">
                {report.type === "maintenance"
                  ? "Upcoming maintenance"
                  : "Upcoming report"}
              </span>
            </span>
            <span className="font-data text-[var(--fg-muted)]">
              {window(report)}
            </span>
          </li>
        ))}
        {windowEnded.map((report) => (
          <li
            className="grid gap-1 px-6 py-4 text-[13px] opacity-70 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
            key={report.id}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <StatusDot aria-hidden state="PENDING" />
              <Link
                className="truncate transition-opacity duration-150 hover:opacity-70"
                href={statusReportUrl(report.id)}
              >
                {report.title}
              </Link>
            </span>
            <span className="text-[var(--fg-muted)] text-xs">Window ended</span>
            <span className="font-data text-[var(--fg-muted)]">
              {window(report)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

type RecentHistoryEntry =
  | { kind: "report"; resolvedMs: number; report: PublicReportEntry }
  | {
      kind: "incident"
      resolvedMs: number
      incident: PublicStatusData["recentIncidents"][number]
    }

/**
 * One chronological "Recent Incidents" feed: resolved authored reports and
 * machine incidents interleave by RESOLVED time, newest first. Sorted by
 * resolved time (not start time) because both source lists are already
 * capped by resolved-time ordering. Re-sorting by start time would drop
 * entries inconsistently.
 */
function mergeRecentHistory(data: PublicStatusData): RecentHistoryEntry[] {
  return [
    ...data.reports.resolved.map<RecentHistoryEntry>((report) => ({
      kind: "report",
      resolvedMs: Date.parse(report.resolvedAt ?? report.startsAt),
      report,
    })),
    ...data.recentIncidents.map<RecentHistoryEntry>((incident) => ({
      kind: "incident",
      resolvedMs: Date.parse(incident.resolvedAt),
      incident,
    })),
  ].sort((left, right) => right.resolvedMs - left.resolvedMs)
}

function StatusCard({
  data,
  groupView,
}: {
  data: PublicStatusData
  groupView: boolean
}) {
  if (data.groups.length === 0) {
    return (
      <section
        aria-labelledby="systems-heading"
        className="rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
      >
        <h2 className="font-semibold text-sm" id="systems-heading">
          Systems
        </h2>
        <div className="mt-4 flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
          <StatusDot aria-hidden state="PENDING" />
          <span>No public monitors in this group</span>
        </div>
      </section>
    )
  }

  // The "see report" annotation supplements the machine state dot while a
  // report is ongoing. The dot itself always shows the machine state.
  const annotations = monitorReportAnnotations(data.reports.ongoing)
  // Timeline tooltips read the same configured zone the rest of the page
  // renders its timestamps in, defaulting to UTC.
  const statusTimeZone = timezoneDisplay(data.config.timezone).timeZone

  return (
    <div aria-label="System availability" className="space-y-6" role="group">
      {data.groups.map((group) => (
        <section
          aria-labelledby={`group-${group.slug}`}
          className="overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
          key={group.slug}
        >
          <div className="flex items-center justify-between px-6 pt-5 pb-2">
            <h2 className="font-semibold text-sm" id={`group-${group.slug}`}>
              {group.name}
            </h2>
            {groupView ? null : (
              <Link
                aria-label={`View ${group.name} status`}
                className="text-[var(--fg-muted)] text-xs transition-colors duration-150 hover:text-[var(--fg)]"
                href={`/status/${group.slug}`}
              >
                View Group
              </Link>
            )}
          </div>
          <div>
            {group.monitors.map((monitor) => {
              const annotation = annotations.get(monitor.id)
              return (
                <div
                  className="grid gap-3 border-[var(--border)] border-t px-6 py-4 sm:grid-cols-[minmax(130px,0.8fr)_minmax(210px,1.4fr)_72px] sm:items-center"
                  key={monitor.id}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot aria-hidden state={monitor.state} />
                    <span className="truncate font-medium text-[13px]">
                      {monitor.name}
                    </span>
                    <span className="sr-only">
                      {stateLabels[monitor.state]}
                      {annotation ? `. ${annotation.label}` : ""}
                    </span>
                    {annotation ? (
                      <span
                        aria-hidden
                        className="shrink-0 whitespace-nowrap text-[var(--fg-muted)] text-xs"
                      >
                        {annotation.label}
                      </span>
                    ) : null}
                  </div>
                  <TimelineBar
                    buckets={monitor.timeline}
                    className="order-3 sm:order-none"
                    label={`${monitor.name}, ${data.config.historyDays}-day availability`}
                    timeZone={statusTimeZone}
                  />
                  <span className="text-right font-data text-[13px]">
                    {formatUptimePercent(
                      monitor.uptime,
                      data.config.uptimeDecimals
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export function StatusPageContent({
  data,
  groupView = false,
}: {
  data: PublicStatusData
  groupView?: boolean
}) {
  const groupName = groupView ? data.groups[0]?.name : undefined
  const zone = timezoneDisplay(
    data.config.timezone,
    new Date(data.lastUpdatedAt)
  )
  const horizontal = data.config.layout === "horizontal"

  const title = (
    <div>
      <h1 className="font-semibold text-base tracking-[-0.32px]">
        {data.pageName}
      </h1>
      {groupName ? (
        <p className="mt-1 text-[13px] text-[var(--fg-muted)]">{groupName}</p>
      ) : null}
    </div>
  )

  // Database unreachable or not yet migrated: render just the page shell
  // (name, logo) plus a neutral notice, no monitor sections, no report
  // sections, and no outage-tinted banner (covers a build on Preview with no
  // DATABASE_URL, or a runtime DB outage).
  if (data.unavailable) {
    return (
      <main className="mx-auto w-full max-w-[720px] px-4 pt-12 pb-16 sm:px-6">
        {groupView ? (
          <Link
            className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
            href="/status"
          >
            ← All Systems
          </Link>
        ) : null}
        <header className="mb-6 space-y-3">
          <PageLogo config={data.config} pageName={data.pageName} />
          {title}
        </header>
        <StatusUnavailableNotice />
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 pt-12 pb-16 sm:px-6">
      {groupView ? (
        <Link
          className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
          href="/status"
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
          <time
            className="block font-data text-[var(--fg-faint)] text-xs"
            dateTime={data.lastUpdatedAt}
          >
            Last updated {formatStatusClock(data.lastUpdatedAt, zone.timeZone)}{" "}
            {zone.full}
          </time>
        </header>
      ) : (
        <header className="mb-6 space-y-3">
          <PageLogo config={data.config} pageName={data.pageName} />
          <div className="flex flex-wrap items-end justify-between gap-2">
            {title}
            <time
              className="font-data text-[var(--fg-faint)] text-xs"
              dateTime={data.lastUpdatedAt}
            >
              Last updated{" "}
              {formatStatusClock(data.lastUpdatedAt, zone.timeZone)} {zone.full}
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
            className="space-y-2 text-[13px] leading-[19px] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
            markdown={data.config.announcementMarkdown}
          />
        </aside>
      ) : null}

      <OverallBanner state={data.overallState} />

      <OngoingReports data={data} zone={zone} />

      {data.currentIncidents.length > 0 ? (
        <section
          aria-labelledby="current-incidents-heading"
          className="mt-6 space-y-3"
        >
          <h2 className="sr-only" id="current-incidents-heading">
            Current Incidents
          </h2>
          {data.currentIncidents.map((incident) => (
            <article
              className="rounded-xl border border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)] p-5"
              key={incident.id}
            >
              <div className="flex items-center gap-2">
                <StatusDot aria-hidden state="DOWN" />
                <h3 className="font-semibold text-sm">
                  {incident.monitorName}
                </h3>
              </div>
              <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
                Ongoing since{" "}
                <span className="font-data">
                  {formatStatusTimestamp(incident.openedAt, zone.timeZone)}{" "}
                  {timezoneOffsetLabel(
                    data.config.timezone,
                    new Date(incident.openedAt)
                  )}
                </span>
                {" · "}
                <span className="font-data">
                  {formatDuration(incident.elapsedSeconds)}
                </span>{" "}
                elapsed
              </p>
              <p className="mt-2 break-words font-data text-[13px] text-[var(--down-text)]">
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
        aria-labelledby="recent-incidents-heading"
        className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
      >
        <h2
          className="px-6 py-4 font-semibold text-sm"
          id="recent-incidents-heading"
        >
          Recent Incidents
        </h2>
        {data.reports.resolved.length > 0 || data.recentIncidents.length > 0 ? (
          <ul className="divide-y divide-[var(--border)]">
            {/* Authored resolved reports (snapshotted names) and the machine
                incidents not folded into a report, merged into one list sorted
                by resolved time descending, matching the resolved-history
                cap's own ordering. */}
            {mergeRecentHistory(data).map((entry) =>
              entry.kind === "report" ? (
                <li
                  className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
                  key={`report-${entry.report.id}`}
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <StatusDot aria-hidden state="PENDING" />
                    <Link
                      className="truncate transition-opacity duration-150 hover:opacity-70"
                      href={statusReportUrl(entry.report.id)}
                    >
                      {entry.report.title}
                    </Link>
                    <span className="sr-only">Resolved report</span>
                  </span>
                  <time
                    className="font-data text-[var(--fg-muted)]"
                    dateTime={entry.report.startsAt}
                  >
                    {formatStatusTimestamp(
                      entry.report.startsAt,
                      zone.timeZone
                    )}{" "}
                    {timezoneOffsetLabel(
                      data.config.timezone,
                      new Date(entry.report.startsAt)
                    )}
                  </time>
                  <span className="font-data sm:min-w-16 sm:text-right">
                    {formatDuration(reportDurationSeconds(entry.report))}
                  </span>
                </li>
              ) : (
                <li
                  className="grid gap-1 px-6 py-4 text-[13px] sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
                  key={`incident-${entry.incident.id}`}
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <StatusDot aria-hidden state="PENDING" />
                    <span className="truncate">
                      {entry.incident.monitorName}
                    </span>
                    <span className="sr-only">Resolved</span>
                  </span>
                  <time
                    className="font-data text-[var(--fg-muted)]"
                    dateTime={entry.incident.openedAt}
                  >
                    {formatStatusTimestamp(
                      entry.incident.openedAt,
                      zone.timeZone
                    )}{" "}
                    {timezoneOffsetLabel(
                      data.config.timezone,
                      new Date(entry.incident.openedAt)
                    )}
                  </time>
                  <span className="font-data sm:min-w-16 sm:text-right">
                    {formatDuration(entry.incident.durationSeconds)}
                  </span>
                </li>
              )
            )}
          </ul>
        ) : (
          <div className="flex items-center gap-2 border-[var(--border)] border-t px-6 py-5 text-[13px] text-[var(--fg-muted)]">
            <StatusDot aria-hidden state="UP" />
            <span>No recent incidents</span>
          </div>
        )}
      </section>
    </main>
  )
}
