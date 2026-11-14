import { notFound } from "next/navigation"

import { IncidentTime } from "@/components/incidents/incident-time"
import { ReportBackLink } from "@/components/incidents/report-back-link"
import {
  ReportDraftBadge,
  ReportStatusChip,
  ReportTypeChip,
} from "@/components/incidents/report-badges"
import { ReportEditor } from "@/components/incidents/report-editor"
import { ReportReadOnlyTimeline } from "@/components/incidents/report-read-only-timeline"
import {
  impactOptions,
  type ReportData,
} from "@/components/incidents/report-status"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import {
  requireStatusReport,
  StatusReportError,
} from "@/lib/api/status-reports"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { getMonitorSettings } from "@/lib/reporting/queries/settings"

export default async function EditStatusReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>
}) {
  const { reportId } = await params
  const session = await authenticateCurrentSession()
  const canWriteReports = hasScope(
    { scopes: roleScopes(session?.role ?? "viewer") },
    "reports:write"
  )
  // Load the report and monitor settings in parallel. notFound() is decided
  // only after both settle so a settings failure still surfaces as an error.
  // Readers skip settings since the monitor picker is editor-only.
  const [reportResult, settingsResult] = await Promise.allSettled([
    requireStatusReport(reportId),
    canWriteReports ? getMonitorSettings() : Promise.resolve(null),
  ])
  if (reportResult.status === "rejected") {
    const error = reportResult.reason
    if (
      error instanceof StatusReportError &&
      error.code === "REPORT_NOT_FOUND"
    ) {
      notFound()
    }
    throw error
  }
  if (settingsResult.status === "rejected") {
    throw settingsResult.reason
  }
  const report = reportResult.value

  if (!(canWriteReports && settingsResult.value)) {
    return (
      <>
        <ReportBackLink />
        <ReportReadOnly report={report} />
      </>
    )
  }

  const monitors = settingsResult.value.monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    group: monitor.group,
  }))

  return (
    <>
      <ReportBackLink />
      {/* Keyed remount per report keeps editor state from leaking across ids. */}
      <ReportEditor key={report.id} monitors={monitors} report={report} />
    </>
  )
}

/** Viewer view of a report. Mirrors the editor layout with no controls. */
function ReportReadOnly({ report }: { report: ReportData }) {
  const impactLabels = new Map(
    impactOptions(report.type).map((option) => [option.value, option.label])
  )
  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words font-semibold text-xl tracking-[-0.02em]">
          {report.title}
        </h1>
        <ReportStatusChip status={report.currentStatus} />
        {report.publishedAt === null ? <ReportDraftBadge /> : null}
        {report.type === "maintenance" ? <ReportTypeChip /> : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
            <div className="border-[var(--border)] border-b px-6 py-5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
              <dt className="text-[var(--fg-muted)] text-xs">Starts</dt>
              <dd className="mt-1 font-data text-[13px]">
                <IncidentTime value={report.startsAt} />
              </dd>
            </div>
            {report.type === "maintenance" ? (
              <div className="border-[var(--border)] border-b px-6 py-5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
                <dt className="text-[var(--fg-muted)] text-xs">Ends</dt>
                <dd className="mt-1 font-data text-[13px]">
                  {report.endsAt ? (
                    <IncidentTime value={report.endsAt} />
                  ) : (
                    "Open-ended"
                  )}
                </dd>
              </div>
            ) : null}
          </dl>

          <ReportReadOnlyTimeline
            report={{
              id: report.id,
              updates: report.updates,
              updatesCount: report.updatesCount,
              updatesNextCursor: report.updatesNextCursor,
            }}
          />
        </div>

        <section
          aria-labelledby="report-affected-title"
          className="h-fit rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
        >
          <h2
            className="font-semibold text-sm tracking-[-0.28px]"
            id="report-affected-title"
          >
            Affected Services
          </h2>
          {report.affected.length === 0 ? (
            <p className="mt-4 text-[13px] text-[var(--fg-muted)]">
              No services affected
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {report.affected.map((row) => (
                <li
                  className="flex items-center justify-between gap-3 text-[13px]"
                  key={row.monitorId}
                >
                  <span className="min-w-0 break-words">{row.monitorName}</span>
                  <span className="shrink-0 text-[var(--fg-muted)] text-xs">
                    {impactLabels.get(row.impact) ?? row.impact}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
