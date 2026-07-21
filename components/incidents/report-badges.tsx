import { cn } from "@/lib/utils"

import { REPORT_STATUS_LABELS, type ReportUpdateStatus } from "./report-status"

export function ReportDraftBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--border-strong)] bg-[var(--chip-bg)] px-2 py-0.5 font-medium text-[var(--fg-muted)] text-xs leading-4",
        className
      )}
    >
      Draft
    </span>
  )
}

export function ReportTypeChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-medium text-[var(--fg-muted)] text-xs leading-4",
        className
      )}
    >
      Maintenance
    </span>
  )
}

export function ReportStatusChip({
  status,
  className,
}: {
  status: ReportUpdateStatus
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-medium text-[var(--fg)] text-xs leading-4",
        className
      )}
    >
      {REPORT_STATUS_LABELS[status]}
    </span>
  )
}
