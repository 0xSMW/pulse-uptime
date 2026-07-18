import { StatusDot, stateLabels, type MonitorState } from "@/components/monitors/status-dot";
import { cn } from "@/lib/utils";

export interface StatusBadgeProps {
  state: MonitorState;
  className?: string;
}

const badgeStyles: Record<MonitorState, string> = {
  UP: "bg-[var(--up-bg)] text-[var(--up-text)]",
  VERIFYING_DOWN: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  VERIFYING_UP: "bg-[var(--verifying-bg)] text-[var(--verifying-text)]",
  DOWN: "bg-[var(--down-bg)] text-[var(--down-text)]",
  PENDING: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
  PAUSED: "bg-[var(--chip-bg)] text-[var(--fg-muted)]",
};

function StatusBadge({ state, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap",
        badgeStyles[state],
        className,
      )}
    >
      <StatusDot state={state} size="sm" aria-hidden />
      {stateLabels[state]}
    </span>
  );
}

export { StatusBadge };
