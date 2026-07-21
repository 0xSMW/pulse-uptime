import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { StatusUnavailableNotice } from "@/components/status-page/status-unavailable-notice"
import { RestrictedMarkdown } from "@/lib/markdown/restricted-markdown"
import { formatDuration } from "@/lib/reporting/format"
import {
  getPublicReportDetail,
  getStatusFaviconDataUri,
  getStatusPageDisplayConfig,
} from "@/lib/reporting/queries/status"
import {
  formatStatusTimestamp,
  timezoneDisplay,
  timezoneOffsetLabel,
} from "@/lib/status-page/display"
import {
  publicReportPhase,
  type ReportPhase,
  reportDurationSeconds,
  reportImpactLabels,
  reportStatusLabels,
} from "@/lib/status-page/reports-display"

// The page people refresh compulsively mid-incident: ISR at the same
// cadence as /status, plus the revalidatePath calls on every report mutation.
export const revalidate = 30

type ReportPageProps = {
  params: Promise<{ reportId: string }>
}

export async function generateMetadata({
  params,
}: ReportPageProps): Promise<Metadata> {
  const { reportId } = await params
  // Report lookup first: unknown ids and drafts 404 without paying for the
  // config read or the favicon bytes. A database-unavailable read is neither
  // of those. It falls through to the default page name below.
  const report = await getPublicReportDetail(reportId)
  if (report === null) {
    notFound()
  }
  const [config, favicon] = await Promise.all([
    getStatusPageDisplayConfig(),
    getStatusFaviconDataUri(),
  ])
  return {
    title: {
      absolute:
        report === "unavailable"
          ? config.name
          : `${report.title} — ${config.name}`,
    },
    robots: { index: true, follow: true },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  }
}

const phaseLabels: Record<ReportPhase, string> = {
  ongoing: "Ongoing",
  upcoming: "Scheduled",
  window_ended: "Window ended",
  resolved: "Resolved",
}

export default async function PublicReportPage({ params }: ReportPageProps) {
  const { reportId } = await params
  const report = await getPublicReportDetail(reportId)
  if (report === null) {
    notFound()
  }
  const config = await getStatusPageDisplayConfig()

  if (report === "unavailable") {
    return (
      <main className="mx-auto w-full max-w-[720px] px-4 pt-12 pb-16 sm:px-6">
        <Link
          className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
          href="/status"
        >
          ← All Systems
        </Link>
        <h1 className="mb-6 font-semibold text-base tracking-[-0.32px]">
          {config.name}
        </h1>
        <StatusUnavailableNotice />
      </main>
    )
  }

  const zone = timezoneDisplay(config.timezone)
  const phase = publicReportPhase(report, new Date())
  const typeLabel = report.type === "maintenance" ? "Maintenance" : "Incident"
  // Each timestamp gets its OWN offset label: a single zone offset reused
  // across every timestamp on the page would be wrong for rows on the other
  // side of a DST boundary, since startsAt and endsAt can even differ from each
  // other when a long window straddles the transition.
  const window = `${formatStatusTimestamp(report.startsAt, zone.timeZone)} ${timezoneOffsetLabel(config.timezone, new Date(report.startsAt))}${
    report.endsAt
      ? ` – ${formatStatusTimestamp(report.endsAt, zone.timeZone)} ${timezoneOffsetLabel(config.timezone, new Date(report.endsAt))}`
      : ""
  }`

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 pt-12 pb-16 sm:px-6">
      <Link
        className="mb-5 inline-flex text-[13px] text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
        href="/status"
      >
        ← All Systems
      </Link>

      <header className="space-y-2">
        <p className="font-medium text-[var(--fg-faint)] text-xs uppercase tracking-wide">
          {typeLabel} ·{" "}
          {phase === "ongoing"
            ? reportStatusLabels[report.currentStatus]
            : phaseLabels[phase]}
        </p>
        <h1 className="font-semibold text-base tracking-[-0.32px]">
          {report.title}
        </h1>
        <p className="font-data text-[13px] text-[var(--fg-muted)]">
          {window}
          {phase === "resolved"
            ? ` · ${formatDuration(reportDurationSeconds(report))}`
            : ""}
        </p>
        {phase === "upcoming" ? (
          <p className="text-[13px] text-[var(--fg-muted)]">
            {report.type === "maintenance"
              ? "This maintenance window has not started yet."
              : "This incident has not started yet."}
          </p>
        ) : null}
        {phase === "window_ended" ? (
          <p className="text-[13px] text-[var(--fg-muted)]">
            The scheduled window has ended; no completing update has been
            posted.
          </p>
        ) : null}
      </header>

      {report.affected.length > 0 ? (
        <section
          aria-labelledby="affected-heading"
          className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
        >
          <h2 className="px-6 py-4 font-semibold text-sm" id="affected-heading">
            Affected Services
          </h2>
          <div className="hide-scrollbar overflow-x-auto border-[var(--border)] border-t">
            <table className="w-full min-w-[360px] border-collapse text-left text-[13px]">
              <thead className="text-[var(--fg-muted)] text-xs">
                <tr className="h-10 border-[var(--border)] border-b">
                  <th className="px-6 font-medium">Service</th>
                  <th className="px-4 font-medium">Group</th>
                  <th className="px-6 font-medium">Impact</th>
                </tr>
              </thead>
              <tbody>
                {/* Snapshotted names: historical reports never re-join the live registry. */}
                {report.affected.map((entry) => (
                  <tr
                    className="h-10 border-[var(--border)] border-b last:border-0"
                    key={entry.monitorId}
                  >
                    <td className="px-6 font-medium">{entry.monitorName}</td>
                    <td className="px-4 text-[var(--fg-muted)]">
                      {entry.groupName ?? "Other"}
                    </td>
                    <td className="px-6 text-[var(--fg-muted)]">
                      {reportImpactLabels[entry.impact]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="updates-heading" className="mt-6">
        <h2 className="font-semibold text-sm" id="updates-heading">
          Updates
        </h2>
        <ol
          className="mt-4 space-y-5 border-[var(--border)] border-l pl-5"
          role="list"
        >
          {report.updates.map((update) => (
            <li className="relative" key={update.id}>
              <span
                aria-hidden
                className="absolute top-1.5 -left-[23px] size-1.5 rounded-full bg-[var(--border-strong)]"
              />
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="font-semibold text-[13px]">
                  {reportStatusLabels[update.status]}
                </h3>
                <time
                  className="font-data text-[var(--fg-faint)] text-xs"
                  dateTime={update.publishedAt}
                >
                  {formatStatusTimestamp(update.publishedAt, zone.timeZone)}{" "}
                  {timezoneOffsetLabel(
                    config.timezone,
                    new Date(update.publishedAt)
                  )}
                </time>
              </div>
              <RestrictedMarkdown
                className="mt-1.5 space-y-2 text-[13px] text-[var(--fg-muted)] leading-[19px] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
                markdown={update.markdown}
              />
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}
