"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

import { formatIncidentDuration } from "@/components/incidents/incident-format"
import { IncidentStatus } from "@/components/incidents/incident-status"
import { IncidentTime } from "@/components/incidents/incident-time"
import { NotificationSummary } from "@/components/incidents/notification-summary"
import type { IncidentSummary } from "@/components/incidents/types"
import { WriteReportButton } from "@/components/incidents/write-report-button"
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

export function IncidentHistoryTable({
  incidents,
}: {
  incidents: IncidentSummary[]
}) {
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
      <h2
        className="mb-3 font-semibold text-sm tracking-[-0.28px]"
        id="incident-history-title"
      >
        History
      </h2>
      <div className="hide-scrollbar overflow-x-auto rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
        <table className="w-full min-w-[600px] border-collapse text-left text-[13px] md:min-w-[760px] lg:min-w-[940px]">
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
              <th className="incident-hide-failure px-4 font-medium">
                Opening Failure
              </th>
              <th className="incident-hide-notifications px-4 font-medium">
                Notifications
              </th>
              <th className="px-6 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              // The whole row navigates to the incident. navigateRow leaves
              // the Monitor link and the Write Report button to their own
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
                <td className="px-6 font-medium">
                  <Link href={incidentHref(incident.id)} prefetch={false}>
                    {incident.monitorName}
                  </Link>
                </td>
                <td className="px-4">
                  <IncidentStatus ongoing={!incident.resolvedAt} />
                </td>
                <td className="whitespace-nowrap px-4 font-data">
                  <IncidentTime value={incident.openedAt} />
                </td>
                <td className="incident-hide-resolved whitespace-nowrap px-4 font-data text-[var(--fg-muted)]">
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
                <td
                  className="incident-hide-failure max-w-52 truncate px-4 font-data"
                  title={incident.openingFailure}
                >
                  {incident.openingFailure}
                </td>
                <td className="incident-hide-notifications px-4">
                  <NotificationSummary summary={incident.notificationSummary} />
                </td>
                <td className="px-6 text-right">
                  <WriteReportButton incidentId={incident.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        @media (max-width: 960px) { .incident-hide-notifications { display: none; } }
        @media (max-width: 720px) { .incident-hide-resolved, .incident-hide-failure { display: none; } }
      `}</style>
    </section>
  )
}
