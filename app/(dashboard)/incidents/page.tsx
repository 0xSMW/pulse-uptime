import Link from "next/link"
import { Suspense } from "react"

import { IncidentEmpty } from "@/components/incidents/incident-empty"
import {
  IncidentFilters,
  IncidentListPagination,
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
  parseIncidentListCursor,
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
    cursor?: string | string[]
    filter?: string | string[]
    monitor?: string | string[]
  }>
}) {
  const params = await searchParams
  const filter = parseFilter(params.filter)
  const monitorId = parseMonitorId(params.monitor)
  // A malformed cursor falls back to the first page instead of erroring.
  const cursorParam = firstParam(params.cursor) ?? null
  const cursor = parseIncidentListCursor(cursorParam) ? cursorParam : null
  const [session, monitorName] = await Promise.all([
    authenticateCurrentSession(),
    monitorId === null ? null : findIncidentMonitorName(monitorId),
  ])
  const scopes = { scopes: roleScopes(session?.role ?? "viewer") }
  const canReadReports = hasScope(scopes, "reports:read")
  const canWriteReports = hasScope(scopes, "reports:write")

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-semibold text-xl tracking-[-0.02em]">
              Incidents
            </h1>
            {monitorId === null ? null : (
              <p className="mt-1 break-words text-[13px] text-[var(--fg-muted)]">
                {monitorName === null ? (
                  "Unknown monitor"
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

      {/* Keyed on the filters and page: switching re-shows the fallback
          instead of freezing the stale list while the new one loads. */}
      <Suspense
        fallback={<IncidentListSkeleton />}
        key={`${filter}:${monitorId ?? ""}:${cursor ?? ""}`}
      >
        <IncidentList
          canReadReports={canReadReports}
          canWriteReports={canWriteReports}
          cursor={cursor}
          filter={filter}
          monitorId={monitorId}
        />
      </Suspense>
    </>
  )
}

async function IncidentList({
  canReadReports,
  canWriteReports,
  cursor,
  filter,
  monitorId,
}: {
  canReadReports: boolean
  canWriteReports: boolean
  cursor: string | null
  filter: IncidentFilter
  monitorId: string | null
}) {
  // The cursor pages the resolved history, or the ongoing list on the Ongoing
  // filter. On All, ongoing cards lead the first page only, so older pages
  // hold history alone and every incident appears exactly once.
  const pagedFilter: IncidentFilter =
    filter === "ongoing" ? "ongoing" : "resolved"
  const [paged, ongoingLead, hasMonitors] = await Promise.all([
    listIncidents({
      filter: pagedFilter,
      monitorId,
      cursor: parseIncidentListCursor(cursor),
    }),
    filter === "all" && cursor === null
      ? listIncidents({ filter: "ongoing", monitorId })
      : null,
    hasConfiguredMonitors(),
  ])
  const ongoing: IncidentSummary[] =
    filter === "ongoing" ? paged.data : (ongoingLead?.data ?? [])
  const history: IncidentSummary[] = filter === "ongoing" ? [] : paged.data
  const moreOngoingCursor = ongoingLead?.nextCursor ?? null
  const pagination = (
    <IncidentListPagination
      cursor={cursor}
      filter={filter}
      monitorId={monitorId}
      nextCursor={paged.nextCursor}
    />
  )

  if (ongoing.length === 0 && history.length === 0) {
    // An empty later page only offers the way back to the newest incidents.
    return cursor === null ? (
      <IncidentEmpty
        filtered={filter !== "all" || monitorId !== null}
        hasMonitors={hasMonitors}
      />
    ) : (
      pagination
    )
  }
  return (
    <>
      <div className="space-y-8">
        {ongoing.length > 0 ? (
          <section aria-labelledby="ongoing-incidents-title">
            <h2 className="sr-only" id="ongoing-incidents-title">
              Ongoing
            </h2>
            <div className="space-y-4">
              {ongoing.map((incident) => (
                <OngoingIncidentCard incident={incident} key={incident.id} />
              ))}
            </div>
            {moreOngoingCursor ? (
              <Link
                className="mt-4 inline-block text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
                href={incidentListHref("ongoing", monitorId, moreOngoingCursor)}
              >
                More ongoing →
              </Link>
            ) : null}
          </section>
        ) : null}
        {history.length > 0 ? (
          <IncidentHistoryTable
            canReadReports={canReadReports}
            canWriteReports={canWriteReports}
            incidents={history}
          />
        ) : null}
      </div>
      {pagination}
    </>
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
