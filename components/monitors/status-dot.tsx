import type { MonitorState } from "@/lib/monitoring/types"
import { cn } from "@/lib/utils"

export type { MonitorState }

export interface StatusDotProps {
  state: MonitorState
  size?: "sm" | "md"
  className?: string
  "aria-label"?: string
  "aria-hidden"?: boolean
}

const stateStyles: Record<MonitorState, string> = {
  UP: "bg-[var(--up)] text-[var(--up)]",
  VERIFYING_DOWN:
    "status-dot-pulse bg-[var(--verifying)] text-[var(--verifying)]",
  VERIFYING_UP:
    "status-dot-pulse bg-[var(--verifying)] text-[var(--verifying)]",
  DOWN: "status-dot-pulse bg-[var(--down)] text-[var(--down)]",
  PENDING: "bg-[var(--neutral-state)] text-[var(--neutral-state)]",
  PAUSED: "bg-[var(--neutral-state)] text-[var(--neutral-state)]",
}

const stateLabels: Record<MonitorState, string> = {
  UP: "Up",
  VERIFYING_DOWN: "Verifying",
  VERIFYING_UP: "Verifying",
  DOWN: "Down",
  PENDING: "Pending",
  PAUSED: "Paused",
}

function StatusDot({
  state,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: StatusDotProps) {
  return (
    <span
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel ?? stateLabels[state])}
      className={cn(
        "relative inline-block shrink-0 rounded-full",
        size === "sm" ? "size-2" : "size-2.5",
        stateStyles[state],
        className
      )}
      role={ariaHidden ? undefined : "img"}
    />
  )
}

export { StatusDot, stateLabels }
