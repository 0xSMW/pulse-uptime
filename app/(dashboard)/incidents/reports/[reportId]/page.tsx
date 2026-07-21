import { notFound } from "next/navigation"

import { ReportBackLink } from "@/components/incidents/report-back-link"
import { ReportEditor } from "@/components/incidents/report-editor"
import {
  requireStatusReport,
  StatusReportError,
} from "@/lib/api/status-reports"
import { getMonitorSettings } from "@/lib/reporting/queries/settings"

export default async function EditStatusReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>
}) {
  const { reportId } = await params
  // Load the report and monitor settings in parallel. notFound() is decided
  // only after both settle so a settings failure still surfaces as an error.
  const [reportResult, settingsResult] = await Promise.allSettled([
    requireStatusReport(reportId),
    getMonitorSettings(),
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
