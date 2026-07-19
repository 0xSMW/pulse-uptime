"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";

import { isPlainLeftClick } from "@/components/dashboard/monitor-table";
import { DependencyStatusDot, dependencyStateLabels } from "@/components/dependencies/dependency-status";
import { DependencyTimeline } from "@/components/dependencies/dependency-timeline";
import { DependencyUpdatedTime } from "@/components/dependencies/dependency-updated-time";
import type { DependencyDashboardRow } from "@/lib/dependencies/queries";

const rowInteractiveSelector = "a, button, input, select, textarea, summary, [role='button'], [role='link']";

// Client leaf for row-click navigation, matching MonitorTable's pattern
// (components/dashboard/monitor-table.tsx), so the surrounding
// DependencyPanel can stay a server component.
export function DependencyPanelRow({ dependency }: { dependency: DependencyDashboardRow }) {
  const router = useRouter();
  const href = `/dependencies/${encodeURIComponent(dependency.id)}`;

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>) {
    if (!isPlainLeftClick(event)) return;
    const target = event.target as HTMLElement;
    if (target.closest?.(rowInteractiveSelector)) return;
    router.push(href);
  }

  return (
    <tr
      onClick={handleRowClick}
      className="h-[60px] cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"
    >
      <td className="px-6">
        <span className="inline-flex items-center gap-2">
          <DependencyStatusDot state={dependency.state} />
          {dependencyStateLabels[dependency.state]}
        </span>
      </td>
      <td className="px-4">
        <Link href={href} prefetch={false} className="font-medium hover:underline">
          {dependency.name}
        </Link>
        <div className="text-xs text-[var(--fg-muted)]">{dependency.provider}</div>
      </td>
      <td className="px-4">
        <DependencyTimeline
          buckets={dependency.timeline24h}
          bucketMs={3_600_000}
          label={`${dependency.name} 24 hour provider timeline`}
          height={24}
          className="max-w-[220px]"
        />
      </td>
      <td className="px-4 font-data text-[var(--fg-muted)]">
        <DependencyUpdatedTime value={dependency.providerUpdatedAt} />
      </td>
      <td className="max-w-[220px] truncate px-6" title={dependency.activeIncidentTitle ?? undefined}>
        {dependency.activeIncidentTitle ?? ""}
      </td>
    </tr>
  );
}
