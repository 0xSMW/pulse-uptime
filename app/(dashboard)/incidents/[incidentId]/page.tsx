import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { DependencyOverlapCard } from "@/components/dependencies/dependency-overlap-card"
import { IncidentEventTrail } from "@/components/incidents/incident-event-trail"
import { IncidentExclusions } from "@/components/incidents/incident-exclusions"
import { formatIncidentDuration } from "@/components/incidents/incident-format"
import {
  IncidentExclusionBadge,
  IncidentStatus,
} from "@/components/incidents/incident-status"
import { IncidentTime } from "@/components/incidents/incident-time"
import { NotificationSummary } from "@/components/incidents/notification-summary"
import type { IncidentDetail } from "@/components/incidents/types"
import { WriteReportButton } from "@/components/incidents/write-report-button"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { withExclusionAttribution } from "@/lib/incidents/exclusion-attribution"
import { listIncidentExclusions } from "@/lib/incidents/exclusions"
import { findIncidentDetail } from "@/lib/reporting/queries/incidents"

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ incidentId: string }>
}) {
  const { incidentId } = await params
  const incident: IncidentDetail | null = await findIncidentDetail(incidentId)
  if (!incident) {
    notFound()
  }

  const session = await authenticateCurrentSession()
  const scopes = { scopes: roleScopes(session?.role ?? "viewer") }
  const canManageMonitors = hasScope(scopes, "monitors:write")
  const canWriteReports = hasScope(scopes, "reports:write")
  const exclusions = await withExclusionAttribution(
    await listIncidentExclusions(incident.id)
  )

  const stats = [
    { label: "Started", value: <IncidentTime value={incident.openedAt} /> },
    {
      label: "Resolved",
      value: incident.resolvedAt ? (
        <IncidentTime
          sameDayOf={incident.openedAt}
          value={incident.resolvedAt}
        />
      ) : (
        "Ongoing"
      ),
    },
    {
      label: "Duration",
      value: formatIncidentDuration(incident.durationSeconds),
    },
  ]

  return (
    <>
      <Link
        className="-mt-1 mb-4 inline-flex items-center gap-1.5 py-2 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        href="/incidents"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Incidents
      </Link>

      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words font-semibold text-xl tracking-[-0.02em]">
          <Link
            className="transition-opacity duration-150 hover:opacity-70"
            href={`/monitors/${encodeURIComponent(incident.monitorId)}`}
          >
            {incident.monitorName}
          </Link>
        </h1>
        <IncidentStatus ongoing={!incident.resolvedAt} />
        <IncidentExclusionBadge status={incident.exclusionStatus} />
        {canWriteReports ? (
          <span className="ml-auto">
            <WriteReportButton incidentId={incident.id} />
          </span>
        ) : null}
      </header>

      <dl className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
        {stats.map((stat) => (
          <div
            className="border-[var(--border)] border-b px-6 py-5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
            key={stat.label}
          >
            <dt className="text-[var(--fg-muted)] text-xs">{stat.label}</dt>
            <dd className="mt-1 font-data text-[13px]">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <section
        aria-labelledby="incident-cause-title"
        className="mb-6 rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
      >
        <h2
          className="font-medium text-[var(--fg-muted)] text-xs"
          id="incident-cause-title"
        >
          Opening Failure
        </h2>
        <p className="mt-2 font-data text-[13px]">
          {incident.openingFailure || "Cause not yet determined"}
        </p>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-[var(--fg-muted)] text-xs">
          <span className="inline-flex gap-2">
            Notifications{" "}
            <NotificationSummary summary={incident.notificationSummary} />
          </span>
        </div>
      </section>

      {incident.overlaps.length > 0 ? (
        <div className="mb-6">
          <DependencyOverlapCard overlaps={incident.overlaps} />
        </div>
      ) : null}

      <IncidentExclusions
        canManageMonitors={canManageMonitors}
        defaultEndAt={incident.resolvedAt}
        defaultStartAt={incident.firstFailureAt ?? incident.openedAt}
        exclusions={exclusions}
        incidentId={incident.id}
        monitorId={incident.monitorId}
      />
      <IncidentEventTrail events={incident.events} />
    </>
  )
}
