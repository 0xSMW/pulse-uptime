import Link from "next/link"

import type { IncidentFilter } from "@/components/incidents/types"
import { cn } from "@/lib/utils"

const filters: Array<{ value: IncidentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "ongoing", label: "Ongoing" },
  { value: "resolved", label: "Resolved" },
]

// Builds an incidents list URL, keeping the monitor filter across status tabs.
export function incidentListHref(
  filter: IncidentFilter,
  monitorId: string | null = null
): string {
  const params = new URLSearchParams()
  if (filter !== "all") {
    params.set("filter", filter)
  }
  if (monitorId !== null) {
    params.set("monitor", monitorId)
  }
  const query = params.toString()
  return query ? `/incidents?${query}` : "/incidents"
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
