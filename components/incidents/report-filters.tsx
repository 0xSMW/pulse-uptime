import Link from "next/link"

import { cn } from "@/lib/utils"

import type { ReportListState, ReportListType } from "./report-status"

const states: Array<{ value: ReportListState; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "ongoing", label: "Ongoing" },
  { value: "resolved", label: "Resolved" },
]

const types: Array<{ value: ReportListType; label: string }> = [
  { value: "all", label: "All types" },
  { value: "incident", label: "Incidents" },
  { value: "maintenance", label: "Maintenance" },
]

export function reportsHref(
  state: ReportListState,
  type: ReportListType,
  cursor?: string | null
): string {
  const params = new URLSearchParams()
  if (state !== "all") {
    params.set("state", state)
  }
  if (type !== "all") {
    params.set("type", type)
  }
  if (cursor) {
    params.set("cursor", cursor)
  }
  const query = params.toString()
  return query ? `/incidents/reports?${query}` : "/incidents/reports"
}

function FilterGroup<T extends string>({
  label,
  options,
  active,
  hrefFor,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  active: T
  hrefFor: (value: T) => string
}) {
  return (
    <nav
      aria-label={label}
      className="flex rounded-md border border-[var(--border-strong)] p-0.5"
    >
      {options.map((option) => (
        <Link
          aria-current={active === option.value ? "page" : undefined}
          className={cn(
            "rounded px-3 py-1.5 font-medium text-[var(--fg-muted)] text-xs hover:text-[var(--fg)]",
            active === option.value && "bg-[var(--chip-bg)] text-[var(--fg)]"
          )}
          href={hrefFor(option.value)}
          key={option.value}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  )
}

export function ReportFilters({
  state,
  type,
}: {
  state: ReportListState
  type: ReportListType
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterGroup
        active={state}
        hrefFor={(value) => reportsHref(value, type)}
        label="Report state"
        options={states}
      />
      <FilterGroup
        active={type}
        hrefFor={(value) => reportsHref(state, value)}
        label="Report type"
        options={types}
      />
    </div>
  )
}
