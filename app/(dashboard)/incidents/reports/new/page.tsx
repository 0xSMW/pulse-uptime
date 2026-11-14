import { redirect } from "next/navigation"

import { ReportBackLink } from "@/components/incidents/report-back-link"
import { ReportEditor } from "@/components/incidents/report-editor"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { getMonitorSettings } from "@/lib/reporting/queries/settings"

export default async function NewStatusReportPage() {
  const session = await authenticateCurrentSession()
  // Viewers can read reports but never open the writing workflow.
  if (
    !hasScope(
      { scopes: roleScopes(session?.role ?? "viewer") },
      "reports:write"
    )
  ) {
    redirect("/incidents/reports")
  }
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
