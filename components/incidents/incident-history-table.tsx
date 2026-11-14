"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

import { formatIncidentDuration } from "@/components/incidents/incident-format"
import { IncidentStateBadges } from "@/components/incidents/incident-status"
import { IncidentTime } from "@/components/incidents/incident-time"
import { NotificationSummary } from "@/components/incidents/notification-summary"
import type { IncidentSummary } from "@/components/incidents/types"
import { WriteReportButton } from "@/components/incidents/write-report-button"
import { buttonVariants } from "@/components/ui/button"
import {
  HOVER_PREFETCH_DELAY_MS,
  isPlainLeftClick,
  navigateRow,
  resolveFullPrefetchOptions,
  shouldPrefetchOnce,
} from "@/components/ui/row-navigation"
import { cn } from "@/lib/utils"

function incidentHref(id: string): string {
  return `/incidents/${encodeURIComponent(id)}`
}

export interface ReportPermissions {
  canReadReports: boolean
  canWriteReports: boolean
}

// Viewing an existing report is navigation, so reports:read is enough.
// Writing a new one promotes the incident, which needs reports:write.
function reportActionFor(
  reportId: string | null | undefined,
  { canReadReports, canWriteReports }: ReportPermissions
): { kind: "view"; reportId: string } | { kind: "write" } | null {
  if (reportId) {
    return canReadReports ? { kind: "view", reportId } : null
  }
  return canWriteReports ? { kind: "write" } : null
}

/**
 * The report control for one incident, shared by the history table and the
 * incident page: View Report when a report exists, Write Report for writers
 * when none does, and nothing otherwise.
 */
export function IncidentReportAction({
  incidentId,
  reportId,
  ...permissions
}: ReportPermissions & {
  incidentId: string
  reportId?: string | null
}) {
  const action = reportActionFor(reportId, permissions)
  if (action === null) {
    return null
  }
  if (action.kind === "write") {
    return <WriteReportButton incidentId={incidentId} />
  }
  return (
    <Link
      className={cn(
        buttonVariants({ variant: "secondary", size: "sm" }),
        "px-2.5"
      )}
      href={`/incidents/reports/${encodeURIComponent(action.reportId)}`}
    >
      View Report
    </Link>
  )
}

export function IncidentHistoryTable({
  incidents,
  ...permissions
}: ReportPermissions & {
  incidents: IncidentSummary[]
}) {
  // Writers always get the column. Viewers get it only when some row has a
  // report to open.
  const showActions = incidents.some(
    (incident) => reportActionFor(incident.reportId, permissions) !== null
  )
  const router = useRouter()
  const hoverIntentRef = useRef<number | undefined>(undefined)
  const prefetchedIdsRef = useRef<Set<string>>(new Set())

  const prefetchIncident = (id: string) => {
    if (!shouldPrefetchOnce(id, prefetchedIdsRef.current)) {
      return
    }
    router.prefetch(incidentHref(id), resolveFullPrefetchOptions())
  }

  // Prefetch keyboard focus immediately. Delay pointer hover for intent.
  const handleRowMouseEnter = (id: string) => {
    window.clearTimeout(hoverIntentRef.current)
    hoverIntentRef.current = window.setTimeout(
      () => prefetchIncident(id),
      HOVER_PREFETCH_DELAY_MS
    )
  }
  const handleRowMouseLeave = () => window.clearTimeout(hoverIntentRef.current)
  useEffect(() => () => window.clearTimeout(hoverIntentRef.current), [])

  return (
    <section aria-labelledby="incident-history-title">
      <h2 className="sr-only" id="incident-history-title">
        History
      </h2>
      {/* Cells wrap instead of forcing a wide table, so the actions column
          fits at desktop widths. The minimum width only scrolls on phones,
          where the scrollbar stays hidden. */}
      <div className="hide-scrollbar overflow-x-auto rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
        <table className="w-full min-w-[600px] border-collapse text-left text-[13px]">
          <thead className="text-[var(--fg-muted)] text-xs">
            <tr className="h-10 border-[var(--border)] border-b">
              <th className="px-6 font-medium">Monitor</th>
              <th className="px-4 font-medium">State</th>
              <th className="px-4 font-medium">Started</th>
              <th className="incident-hide-resolved px-4 font-medium">
                Resolved
              </th>
              <th className="px-4 font-medium">Duration</th>
              {/* Opening Failure already carries the HTTP status code
                  (failureLabel renders "HTTP <code>"), so there is no
                  separate Status column. */}
              <th className="px-4 font-medium">Opening Failure</th>
              <th className="incident-hide-notifications px-4 font-medium">
                Notifications
              </th>
              {showActions ? (
                <th className="px-6 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              // The whole row navigates to the incident. navigateRow leaves
              // the Monitor link and the report link or button to their own
              // clicks (the interactive-element guard). The Monitor link
              // stays a real anchor for middle-click and assistive tech.
              <tr
                className={cn(
                  "h-12 cursor-pointer border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
                )}
                key={incident.id}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) {
                    return
                  }
                  navigateRow(
                    event.target,
                    incidentHref(incident.id),
                    router.push
                  )
                }}
                onFocus={() => prefetchIncident(incident.id)}
                onMouseEnter={() => handleRowMouseEnter(incident.id)}
                onMouseLeave={handleRowMouseLeave}
              >
                <td className="wrap-anywhere min-w-32 px-6 py-2 font-medium">
                  <Link href={incidentHref(incident.id)} prefetch={false}>
                    {incident.monitorName}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <IncidentStateBadges
                      exclusionStatus={incident.exclusionStatus}
                      ongoing={!incident.resolvedAt}
                    />
                  </div>
                </td>
                <td className="px-4 py-2 font-data">
                  <IncidentTime value={incident.openedAt} />
                </td>
                <td className="incident-hide-resolved px-4 py-2 font-data text-[var(--fg-muted)]">
                  {incident.resolvedAt ? (
                    <IncidentTime
                      sameDayOf={incident.openedAt}
                      value={incident.resolvedAt}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-4 font-data">
                  {formatIncidentDuration(incident.durationSeconds)}
                </td>
                <td className="wrap-anywhere min-w-28 max-w-52 px-4 py-2 font-data">
                  {incident.openingFailure}
                </td>
                <td className="incident-hide-notifications px-4 py-2">
                  <NotificationSummary summary={incident.notificationSummary} />
                </td>
                {showActions ? (
                  <td className="px-6 py-2 text-right">
                    <IncidentReportAction
                      incidentId={incident.id}
                      reportId={incident.reportId}
                      {...permissions}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        @media (max-width: 960px) { .incident-hide-notifications { display: none; } }
        @media (max-width: 720px) { .incident-hide-resolved { display: none; } }
      `}</style>
    </section>
  )
}
