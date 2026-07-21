import { Suspense } from "react"

import { IncidentEmpty } from "@/components/incidents/incident-empty"
import { IncidentFilters } from "@/components/incidents/incident-filters"
import { IncidentHistoryTable } from "@/components/incidents/incident-history-table"
import { IncidentsTabs } from "@/components/incidents/incidents-tabs"
import { OngoingIncidentCard } from "@/components/incidents/ongoing-incident-card"
import type {
  IncidentFilter,
  IncidentSummary,
} from "@/components/incidents/types"
import {
  hasConfiguredMonitors,
  listIncidents,
} from "@/lib/reporting/queries/incidents"

function parseFilter(value: string | string[] | undefined): IncidentFilter {
  const filter = Array.isArray(value) ? value[0] : value
  return filter === "ongoing" || filter === "resolved" ? filter : "all"
}

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>
}) {
  const filter = parseFilter((await searchParams).filter)

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-semibold text-xl tracking-[-0.02em]">
              Incidents
            </h1>
            <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
              Endpoint outage history
            </p>
          </div>
          <IncidentFilters active={filter} />
        </div>
        <IncidentsTabs className="mt-4" />
      </header>

      {/* key={filter}: switching filters re-shows the fallback instead of
          freezing the stale list while the new one loads. */}
      <Suspense fallback={<IncidentListSkeleton />} key={filter}>
        <IncidentList filter={filter} />
      </Suspense>
    </>
  )
}

async function IncidentList({ filter }: { filter: IncidentFilter }) {
  const [incidents, hasMonitors]: [IncidentSummary[], boolean] =
    await Promise.all([listIncidents(filter), hasConfiguredMonitors()])
  const ongoing = incidents.filter((incident) => !incident.resolvedAt)
  const history = incidents.filter((incident) => Boolean(incident.resolvedAt))

  if (incidents.length === 0) {
    return (
      <IncidentEmpty filtered={filter !== "all"} hasMonitors={hasMonitors} />
    )
  }
  return (
    <div className="space-y-8">
      {ongoing.length > 0 ? (
        <section aria-labelledby="ongoing-incidents-title">
          <h2
            className="mb-3 font-semibold text-sm tracking-[-0.28px]"
            id="ongoing-incidents-title"
          >
            Ongoing
          </h2>
          <div className="space-y-4">
            {ongoing.map((incident) => (
              <OngoingIncidentCard incident={incident} key={incident.id} />
            ))}
          </div>
        </section>
      ) : null}
      {history.length > 0 ? <IncidentHistoryTable incidents={history} /> : null}
    </div>
  )
}

function IncidentListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading incidents"
      className="animate-pulse space-y-6"
    >
      <div className="h-32 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-80 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  )
}
