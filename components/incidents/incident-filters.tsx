import Link from "next/link"

import type { IncidentFilter } from "@/components/incidents/types"
import { cn } from "@/lib/utils"

const filters: Array<{ value: IncidentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "ongoing", label: "Ongoing" },
  { value: "resolved", label: "Resolved" },
]

// Builds an incidents list URL, keeping the monitor filter across status tabs.
// Status links omit the cursor so switching filters starts at the newest page.
export function incidentListHref(
  filter: IncidentFilter,
  monitorId: string | null = null,
  cursor: string | null = null
): string {
  const params = new URLSearchParams()
  if (filter !== "all") {
    params.set("filter", filter)
  }
  if (monitorId !== null) {
    params.set("monitor", monitorId)
  }
  if (cursor) {
    params.set("cursor", cursor)
  }
  const query = params.toString()
  return query ? `/incidents?${query}` : "/incidents"
}

/**
 * Cursor pagination matching the reports list: "Older incidents" follows
 * nextCursor with the status and monitor filters kept. Cursors only point
 * forward, so the back link returns to the first page and reads "Latest
 * incidents" rather than promising the previous page.
 */
export function IncidentListPagination({
  filter,
  monitorId,
  cursor,
  nextCursor,
}: {
  filter: IncidentFilter
  monitorId: string | null
  cursor: string | null
  nextCursor: string | null
}) {
  if (!(cursor || nextCursor)) {
    return null
  }
  return (
    <nav
      aria-label="Incidents pagination"
      className="mt-4 flex items-center justify-between text-[13px]"
    >
      {cursor ? (
        <Link
          className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href={incidentListHref(filter, monitorId)}
        >
          ← Latest incidents
        </Link>
      ) : (
        <span aria-hidden />
      )}
      {nextCursor ? (
        <Link
          className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href={incidentListHref(filter, monitorId, nextCursor)}
        >
          Older incidents →
        </Link>
      ) : null}
    </nav>
  )
}

export function IncidentFilters({
  active,
  monitorId = null,
}: {
  active: IncidentFilter
  monitorId?: string | null
}) {
  return (
    <nav
      aria-label="Incident status"
      className="flex shrink-0 rounded-md border border-[var(--border-strong)] p-0.5"
    >
      {filters.map((filter) => (
        <Link
          aria-current={active === filter.value ? "page" : undefined}
          className={cn(
            "rounded px-3 py-1.5 font-medium text-[var(--fg-muted)] text-xs hover:text-[var(--fg)]",
            active === filter.value && "bg-[var(--chip-bg)] text-[var(--fg)]"
          )}
          href={incidentListHref(filter.value, monitorId)}
          key={filter.value}
        >
          {filter.label}
        </Link>
      ))}
    </nav>
  )
}
