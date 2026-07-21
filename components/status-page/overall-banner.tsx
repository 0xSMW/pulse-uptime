import {
  StatusDot,
  type VisibleMonitorState,
} from "@/components/monitors/status-dot"
import type { PublicOverallState } from "@/lib/status-page/reports-display"
import { cn } from "@/lib/utils"

type OverallState = PublicOverallState

const presentation: Record<
  OverallState,
  { label: string; monitorState: VisibleMonitorState; className: string }
> = {
  operational: {
    label: "All Systems Operational",
    monitorState: "UP",
    className:
      "border-[color-mix(in_srgb,var(--up)_40%,transparent)] bg-[var(--up-bg)]",
  },
  investigating: {
    label: "Investigating",
    monitorState: "VERIFYING_DOWN",
    className:
      "border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)]",
  },
  // Report-driven tier: an ongoing degraded-impact report yields this even
  // when every machine state is UP.
  degraded: {
    label: "Degraded Performance",
    monitorState: "VERIFYING_DOWN",
    className:
      "border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)]",
  },
  // Ongoing maintenance-type report, only when nothing redder is happening.
  maintenance: {
    label: "Maintenance in Progress",
    monitorState: "PAUSED",
    className: "border-[var(--border-strong)] bg-[var(--chip-bg)]",
  },
  outage: {
    label: "Major Outage",
    monitorState: "DOWN",
    className:
      "border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)]",
  },
  empty: {
    label: "No Monitors Configured",
    monitorState: "PENDING",
    className: "border-[var(--border-strong)] bg-[var(--chip-bg)]",
  },
}

export function OverallBanner({ state }: { state: OverallState }) {
  const current = presentation[state]

  return (
    <div
      aria-label={`Overall status: ${current.label}`}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-xl border px-5 py-4 font-semibold text-[15px]",
        current.className
      )}
      role="status"
    >
      <StatusDot aria-hidden size="md" state={current.monitorState} />
      <span>{current.label}</span>
    </div>
  )
}
