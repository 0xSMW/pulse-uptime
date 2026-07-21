import Link from "next/link"

import { StatusPageSettings } from "@/components/settings/status-page-settings"
import { getStatusPageSettings } from "@/lib/reporting/queries/settings"

export default async function StatusPageSettingsPage() {
  const data = await getStatusPageSettings()

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-semibold text-xl tracking-[-0.02em]">
          Status page
        </h1>
        <div className="flex items-center gap-4 text-[13px]">
          <Link
            className="text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
            href="/incidents/reports"
          >
            Manage status reports →
          </Link>
          <Link
            className="text-[var(--fg-muted)] transition-colors duration-150 hover:text-[var(--fg)]"
            href="/status"
          >
            View status page ↗
          </Link>
        </div>
      </div>
      <StatusPageSettings data={data} />
    </>
  )
}
