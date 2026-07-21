import { Suspense } from "react"

import { DatabaseHealthCard } from "@/components/settings/database-health"
import { MonitoringHealthCard } from "@/components/settings/monitoring-health"
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"
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
  const { databaseHealth, databaseHealthError, monitoringWarnings } =
    await getSystemSettings()
  return (
    <div className="space-y-6">
      <MonitoringHealthCard warnings={monitoringWarnings} />
      <DatabaseHealthCard
        initialData={databaseHealth}
        initialError={databaseHealthError}
      />
    </div>
  )
}
