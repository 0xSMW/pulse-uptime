import type { DependencyState } from "@/lib/dependencies/types";
import { cn } from "@/lib/utils";

export interface DependencyStatusDotProps {
  state: DependencyState;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
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
};

export const dependencyStateLabels: Record<DependencyState, string> = {
  OPERATIONAL: "Operational",
  DEGRADED: "Degraded",
  OUTAGE: "Outage",
  MAINTENANCE: "Maintenance",
  UNKNOWN: "Unknown",
};

export function DependencyStatusDot({
  state,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: DependencyStatusDotProps) {
  return (
    <span
      role={ariaHidden ? undefined : "img"}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel ?? dependencyStateLabels[state])}
      className={cn(
        "relative inline-block shrink-0 rounded-full",
        size === "sm" ? "size-2" : "size-2.5",
        dotStyles[state],
        className,
      )}
    />
  );
}

const badgeStyles: Record<DependencyState, string> = {
  OPERATIONAL: "bg-[var(--up-bg)] text-[var(--up-text)]",
  DEGRADED: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  OUTAGE: "bg-[var(--down-bg)] text-[var(--down-text)]",
  MAINTENANCE: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
  UNKNOWN: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
};

export function DependencyStatusBadge({ state, className }: { state: DependencyState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap",
        badgeStyles[state],
        className,
      )}
    >
      <DependencyStatusDot state={state} size="sm" aria-hidden />
      {dependencyStateLabels[state]}
    </span>
  );
}
