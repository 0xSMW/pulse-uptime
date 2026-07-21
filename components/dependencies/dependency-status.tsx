import type {
  DependencyFidelity,
  DependencyState,
} from "@/lib/dependencies/types"
import { cn } from "@/lib/utils"

// Shown on an incident_only dependency: its source publishes provider incident
// prose but no structured component state, so this muted chip tells the reader
// the row carries incident context, not a normalized component reading. The
// chip style matches the neutral chips already used across the dependency
// surfaces (Provider reported, the UNKNOWN badge): --chip-bg on --fg-muted,
// color communicates no state.
export const INCIDENT_FEED_ONLY_LABEL = "Incident feed only"

export function DependencyFidelityBadge({
  fidelity,
  className,
}: {
  fidelity: DependencyFidelity
  className?: string
}) {
  if (fidelity !== "incident_only") {
    return null
  }
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded bg-[var(--chip-bg)] px-1.5 py-0.5 font-medium text-[11px] text-[var(--fg-muted)]",
        className
      )}
    >
      {INCIDENT_FEED_ONLY_LABEL}
    </span>
  )
}

export interface DependencyStatusDotProps {
  state: DependencyState
  pending?: boolean
  size?: "sm" | "md"
  className?: string
  "aria-label"?: string
  "aria-hidden"?: boolean
}

// Decision 5, Docs/DEPENDENCY-MONITORING.md "Implementation plan": dependency
// states reuse the existing color tokens, no new colors introduced. Color
// communicates state only, so MAINTENANCE and UNKNOWN both render neutral
// rather than inventing a sixth visual state.
const dotStyles: Record<DependencyState, string> = {
  OPERATIONAL: "bg-[var(--up)] text-[var(--up)]",
  DEGRADED: "status-dot-pulse bg-[var(--verifying)] text-[var(--verifying)]",
  OUTAGE: "status-dot-pulse bg-[var(--down)] text-[var(--down)]",
  MAINTENANCE: "bg-[var(--neutral-state)] text-[var(--neutral-state)]",
  UNKNOWN: "bg-[var(--neutral-state)] text-[var(--neutral-state)]",
}

export const dependencyStateLabels: Record<DependencyState, string> = {
  OPERATIONAL: "Operational",
  DEGRADED: "Degraded",
  OUTAGE: "Outage",
  MAINTENANCE: "Maintenance",
  UNKNOWN: "Unknown",
}

// Shown while pendingFirstPoll is true, before the first successful poll lands.
// A fresh dependency has no reading yet, so it reads as an in-progress check
// rather than Unknown, which is reserved for a poll that succeeded but could
// not resolve the component. The dot reuses the neutral in-progress treatment,
// matching the monitor PENDING dot, so no new color is introduced.
export const dependencyPendingLabel = "Checking"
const pendingDotStyle = "bg-[var(--neutral-state)] text-[var(--neutral-state)]"
const pendingBadgeStyle = "bg-[var(--chip-bg)] text-[var(--fg-muted)]"

/** Status text for a dependency, showing the checking state before the first poll lands. */
export function dependencyStatusLabel(
  state: DependencyState,
  pending: boolean
): string {
  return pending ? dependencyPendingLabel : dependencyStateLabels[state]
}

export function DependencyStatusDot({
  state,
  pending = false,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: DependencyStatusDotProps) {
  return (
    <span
      aria-hidden={ariaHidden}
      aria-label={
        ariaHidden
          ? undefined
          : (ariaLabel ?? dependencyStatusLabel(state, pending))
      }
      className={cn(
        "relative inline-block shrink-0 rounded-full",
        size === "sm" ? "size-2" : "size-2.5",
        pending ? pendingDotStyle : dotStyles[state],
        className
      )}
      role={ariaHidden ? undefined : "img"}
    />
  )
}

const badgeStyles: Record<DependencyState, string> = {
  OPERATIONAL: "bg-[var(--up-bg)] text-[var(--up-text)]",
  DEGRADED: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  OUTAGE: "bg-[var(--down-bg)] text-[var(--down-text)]",
  MAINTENANCE: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
  UNKNOWN: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
}

export function DependencyStatusBadge({
  state,
  pending = false,
  className,
}: {
  state: DependencyState
  pending?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs leading-4",
        pending ? pendingBadgeStyle : badgeStyles[state],
        className
      )}
    >
      <DependencyStatusDot
        aria-hidden
        pending={pending}
        size="sm"
        state={state}
      />
      {dependencyStatusLabel(state, pending)}
    </span>
  )
}
