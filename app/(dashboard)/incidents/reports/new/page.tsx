import { ReportBackLink } from "@/components/incidents/report-back-link"
import { ReportEditor } from "@/components/incidents/report-editor"
import { getMonitorSettings } from "@/lib/reporting/queries/settings"

export default async function NewStatusReportPage() {
  const settings = await getMonitorSettings()
  const monitors = settings.monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    group: monitor.group,
  }))

  return (
    <>
      <ReportBackLink />
      <ReportEditor monitors={monitors} report={null} />
    </>
  )
}
