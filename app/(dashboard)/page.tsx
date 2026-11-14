import { Suspense } from "react"

import { HealthBanner } from "@/components/dashboard/health-banner"
import { MonitorTable } from "@/components/dashboard/monitor-table"
import { MonitorTableSkeleton } from "@/components/dashboard/monitor-table-skeleton"
import { NewMonitorAction } from "@/components/dashboard/new-monitor-action"
import { DependencyPanel } from "@/components/dependencies/dependency-panel"
import { DependencyPanelSkeleton } from "@/components/dependencies/dependency-panel-skeleton"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { getHealthWarnings } from "@/lib/monitoring/health"
import { listDashboardMonitors } from "@/lib/monitoring/queries"

export default async function OverviewPage() {
  const session = await authenticateCurrentSession()
  const canManageMonitors = hasScope(
    { scopes: roleScopes(session?.role ?? "viewer") },
    "monitors:write"
  )
  // Matches requireAdminSettings, which gates the System settings page.
  const canOpenSystem = session?.role === "admin"

  return (
    <>
      {/* Empty fallback: warnings are rare, and layout shift from a
          late-arriving alert banner is acceptable for an alert. */}
      <Suspense fallback={null}>
        <HealthBannerIsland canOpenSystem={canOpenSystem} />
      </Suspense>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-semibold text-xl tracking-[-0.02em]">Monitors</h1>
        <NewMonitorAction canManageMonitors={canManageMonitors} />
      </div>
      <Suspense fallback={<MonitorTableSkeleton />}>
        <MonitorTableIsland />
      </Suspense>
      <Suspense fallback={<DependencyPanelSkeleton />}>
        <DependencyPanel />
      </Suspense>
    </>
  )
}

async function HealthBannerIsland({
  canOpenSystem,
}: {
  canOpenSystem: boolean
}) {
  return (
    <HealthBanner
      canOpenSystem={canOpenSystem}
      warnings={await getHealthWarnings()}
    />
  )
}

async function MonitorTableIsland() {
  return <MonitorTable monitors={await listDashboardMonitors()} />
}
