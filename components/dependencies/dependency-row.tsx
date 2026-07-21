"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";

import { DependencyFidelityBadge, DependencyStatusDot, dependencyStatusLabel } from "@/components/dependencies/dependency-status";
import { DependencyTimeline } from "@/components/dependencies/dependency-timeline";
import { DependencyUpdatedTime } from "@/components/dependencies/dependency-updated-time";
import { useTimezone } from "@/components/dashboard/timezone-provider";
import { isPlainLeftClick, navigateRow } from "@/components/ui/row-navigation";
import type { DependencyDashboardRow } from "@/lib/dependencies/queries";

// Client leaf for row-click navigation, matching the shared row-navigation
// pattern (components/ui/row-navigation.ts), so the surrounding
// DependencyPanel can stay a server component.
export function DependencyPanelRow({ dependency }: { dependency: DependencyDashboardRow }) {
  const router = useRouter();
  const { resolvedTimeZone } = useTimezone();
  const href = `/dependencies/${encodeURIComponent(dependency.id)}`;

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>) {
    if (!isPlainLeftClick(event)) return;
    navigateRow(event.target, href, router.push);
  }

  return (
    <tr
      onClick={handleRowClick}
      className="h-[60px] cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"
    >
      <td className="px-6">
        <span className="inline-flex items-center gap-2">
          <DependencyStatusDot state={dependency.state} pending={dependency.pendingFirstPoll} />
          {dependencyStatusLabel(dependency.state, dependency.pendingFirstPoll)}
        </span>
      </td>
      <td className="px-4">
        <Link href={href} prefetch={false} className="font-medium">
          {dependency.name}
        </Link>
        <div className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
          <span>{dependency.provider}</span>
          <DependencyFidelityBadge fidelity={dependency.fidelity} />
        </div>
      </td>
      <td className="px-4">
        <DependencyTimeline
          buckets={dependency.timeline24h}
          bucketMs={3_600_000}
          label={`${dependency.name} 24 hour provider timeline`}
          height={24}
          className="max-w-[220px]"
          timeZone={resolvedTimeZone}
        />
      </td>
      <td className="px-4 font-data text-[var(--fg-muted)]">
        <DependencyUpdatedTime value={dependency.providerUpdatedAt} pending={dependency.pendingFirstPoll} />
      </td>
      <td className="max-w-[220px] truncate px-6" title={dependency.activeIncidentTitle ?? undefined}>
        {dependency.activeIncidentTitle ?? ""}
      </td>
    </tr>
  );
}
