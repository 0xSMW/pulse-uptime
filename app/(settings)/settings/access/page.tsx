import { Suspense } from "react"

import { AccessSettings } from "@/components/settings/access-settings"
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"
import { requireAdminSettings } from "@/lib/auth/require-admin"
import { getAccessSettings } from "@/lib/reporting/queries/settings"

export default function AccessSettingsPage() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Access</h1>
      <Suspense
        fallback={
          <SettingsCardsSkeleton
            heights={["h-[320px]", "h-56", "h-64"]}
            label="Loading access settings"
          />
        }
      >
        <AccessSettingsIsland />
      </Suspense>
    </>
  )
}

async function AccessSettingsIsland() {
  await requireAdminSettings()
  return <AccessSettings data={await getAccessSettings()} />
}
