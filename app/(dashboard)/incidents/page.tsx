import Link from "next/link"
import { Suspense } from "react"

import { IncidentEmpty } from "@/components/incidents/incident-empty"
import {
  IncidentFilters,
  incidentListHref,
} from "@/components/incidents/incident-filters"
import { IncidentHistoryTable } from "@/components/incidents/incident-history-table"
import { IncidentsTabs } from "@/components/incidents/incidents-tabs"
import { OngoingIncidentCard } from "@/components/incidents/ongoing-incident-card"
import type {
  IncidentFilter,
  IncidentSummary,
} from "@/components/incidents/types"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import { authenticateCurrentSession } from "@/lib/auth/session"
import {
  findIncidentMonitorName,
  hasConfiguredMonitors,
  listIncidents,
} from "@/lib/reporting/queries/incidents"

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseFilter(value: string | string[] | undefined): IncidentFilter {
  const filter = firstParam(value)
  return filter === "ongoing" || filter === "resolved" ? filter : "all"
}

function parseMonitorId(value: string | string[] | undefined): string | null {
  const monitorId = firstParam(value)?.trim()
  return monitorId ? monitorId : null
}

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string | string[]
    monitor?: string | string[]
  }>
}) {
  const params = await searchParams
  const filter = parseFilter(params.filter)
  const monitorId = parseMonitorId(params.monitor)
  const [session, monitorName] = await Promise.all([
    authenticateCurrentSession(),
    monitorId === null ? null : findIncidentMonitorName(monitorId),
  ])
  const canWriteReports = hasScope(
    { scopes: roleScopes(session?.role ?? "viewer") },
    "reports:write"
  )

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-semibold text-xl tracking-[-0.02em]">
              Incidents
            </h1>
            {monitorId === null ? (
              <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
                Endpoint outage history
              </p>
            ) : (
              <p className="mt-1 break-words text-[13px] text-[var(--fg-muted)]">
                Outage history for{" "}
                {monitorName === null ? (
                  "an unknown monitor"
                ) : (
                  <Link
                    className="font-medium text-[var(--fg)] transition-opacity duration-150 hover:opacity-70"
                    href={`/monitors/${encodeURIComponent(monitorId)}`}
                  >
                    {monitorName}
                  </Link>
                )}
                {" · "}
                <Link
                  className="transition-colors duration-150 hover:text-[var(--fg)]"
                  href={incidentListHref(filter)}
                >
                  All monitors
                </Link>
              </p>
            )}
          </div>
          <IncidentFilters active={filter} monitorId={monitorId} />
        </div>
        <IncidentsTabs className="mt-4" />
      </header>

      {/* Keyed on both filters: switching re-shows the fallback instead of
          freezing the stale list while the new one loads. */}
      <Suspense
        fallback={<IncidentListSkeleton />}
        key={`${filter}:${monitorId ?? ""}`}
      >
        <IncidentList
          canWriteReports={canWriteReports}
          filter={filter}
          monitorId={monitorId}
        />
      </Suspense>
    </>
  )
}

async function IncidentList({
  canWriteReports,
  filter,
  monitorId,
}: {
  canWriteReports: boolean
  filter: IncidentFilter
  monitorId: string | null
}) {
  const [incidents, hasMonitors]: [IncidentSummary[], boolean] =
    await Promise.all([
      listIncidents(filter, monitorId),
      hasConfiguredMonitors(),
    ])
  const ongoing = incidents.filter((incident) => !incident.resolvedAt)
  const history = incidents.filter((incident) => Boolean(incident.resolvedAt))

  if (incidents.length === 0) {
    return (
      <IncidentEmpty
        filtered={filter !== "all" || monitorId !== null}
        hasMonitors={hasMonitors}
      />
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
      {history.length > 0 ? (
        <IncidentHistoryTable
          canWriteReports={canWriteReports}
          incidents={history}
        />
      ) : null}
    </div>
  )
}

function IncidentListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading incidents"
      className="animate-pulse space-y-6"
      role="status"
    >
      <div className="h-32 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-80 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  )
}
