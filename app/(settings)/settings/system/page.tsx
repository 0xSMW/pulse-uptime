import { Suspense } from "react"

import { DatabaseHealthCard } from "@/components/settings/database-health"
import { DomainMonitoringCard } from "@/components/settings/domain-monitoring"
import { MonitoringLoopCard } from "@/components/settings/monitoring-health"
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"
import { requireAdminSettings } from "@/lib/auth/require-admin"
import { getSystemSettings } from "@/lib/reporting/queries/settings"

export default function SystemSettingsPage() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">System</h1>
      <Suspense
        fallback={
          <SettingsCardsSkeleton
            heights={["h-24", "h-64"]}
            label="Loading system settings"
          />
        }
      >
        <SystemSettingsIsland />
      </Suspense>
    </>
  )
}

async function SystemSettingsIsland() {
  await requireAdminSettings()
  const {
    databaseHealth,
    databaseHealthError,
    domainMonitoring,
    monitoringWarnings,
  } = await getSystemSettings()
  return (
    <div className="space-y-6">
      <MonitoringLoopCard warnings={monitoringWarnings} />
      <DomainMonitoringCard data={domainMonitoring} />
      <DatabaseHealthCard
        initialData={databaseHealth}
        initialError={databaseHealthError}
      />
    </div>
  )
}
