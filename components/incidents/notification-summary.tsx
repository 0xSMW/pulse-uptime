import type { IncidentSummary } from "@/components/incidents/types"
import { cn } from "@/lib/utils"

export function NotificationSummary({
  summary,
}: {
  summary: IncidentSummary["notificationSummary"]
}) {
  const label =
    summary.state === "sent"
      ? `Sent · ${summary.sentCount}`
      : summary.state === "retrying"
        ? "Retrying"
        : summary.state === "dead"
          ? "Dead"
          : "—"

  return (
    <span
      className={cn(
        "font-data",
        summary.state === "retrying" && "text-[var(--verifying-text)]",
        summary.state === "dead" && "text-[var(--down-text)]"
      )}
    >
      {label}
    </span>
  )
}
