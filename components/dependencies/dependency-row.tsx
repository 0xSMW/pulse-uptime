"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import type { MouseEvent } from "react"
import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  DependencyFidelityBadge,
  DependencyStatusDot,
  dependencyStatusLabel,
} from "@/components/dependencies/dependency-status"
import { DependencyTimeline } from "@/components/dependencies/dependency-timeline"
import { DependencyUpdatedTime } from "@/components/dependencies/dependency-updated-time"
import { isPlainLeftClick, navigateRow } from "@/components/ui/row-navigation"
import type { DependencyDashboardRow } from "@/lib/dependencies/queries"

// Client leaf for row-click navigation, matching the shared row-navigation
// pattern (components/ui/row-navigation.ts), so the surrounding
// DependencyPanel can stay a server component.
export function DependencyPanelRow({
  dependency,
}: {
  dependency: DependencyDashboardRow
}) {
  const router = useRouter()
  const { resolvedTimeZone } = useTimezone()
  const href = `/dependencies/${encodeURIComponent(dependency.id)}`

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>) {
    if (!isPlainLeftClick(event)) {
      return
    }
    navigateRow(event.target, href, router.push)
  }

  return (
    <tr
      className="h-[60px] cursor-pointer border-[var(--border)] border-b last:border-0 hover:bg-[var(--hover)]"
      onClick={handleRowClick}
    >
      <td className="px-6">
        <span className="inline-flex items-center gap-2">
          <DependencyStatusDot
            pending={dependency.pendingFirstPoll}
            state={dependency.state}
          />
          {dependencyStatusLabel(dependency.state, dependency.pendingFirstPoll)}
        </span>
      </td>
      <td className="px-4">
        <Link className="font-medium" href={href} prefetch={false}>
          {dependency.name}
        </Link>
        <div className="flex items-center gap-1.5 text-[var(--fg-muted)] text-xs">
          <span>{dependency.provider}</span>
          <DependencyFidelityBadge fidelity={dependency.fidelity} />
        </div>
      </td>
      <td className="px-4">
        <DependencyTimeline
          bucketMs={3_600_000}
          buckets={dependency.timeline24h}
          className="max-w-[220px]"
          height={24}
          label={`${dependency.name} 24 hour provider timeline`}
          timeZone={resolvedTimeZone}
        />
      </td>
      <td className="px-4 font-data text-[var(--fg-muted)]">
        <DependencyUpdatedTime
          pending={dependency.pendingFirstPoll}
          value={dependency.providerUpdatedAt}
        />
      </td>
      <td
        className="max-w-[220px] truncate px-6"
        title={dependency.activeIncidentTitle ?? undefined}
      >
        {dependency.activeIncidentTitle ?? ""}
      </td>
    </tr>
  )
}
