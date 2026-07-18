import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { cn } from "@/lib/utils";

type OverallState = "operational" | "investigating" | "outage" | "empty";

const presentation: Record<
  OverallState,
  { label: string; monitorState: MonitorState; className: string }
> = {
  operational: {
    label: "All Systems Operational",
    monitorState: "UP",
    className: "border-[color-mix(in_srgb,var(--up)_40%,transparent)] bg-[var(--up-bg)]",
  },
  investigating: {
    label: "Investigating",
    monitorState: "VERIFYING_DOWN",
    className:
      "border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)]",
  },
  outage: {
    label: "Major Outage",
    monitorState: "DOWN",
    className: "border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)]",
  },
  empty: {
    label: "No Monitors Configured",
    monitorState: "PENDING",
    className: "border-[var(--border-strong)] bg-[var(--chip-bg)]",
  },
};

export function OverallBanner({ state }: { state: OverallState }) {
  const current = presentation[state];

  return (
    <div
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-xl border px-5 py-4 text-[15px] font-semibold",
        current.className,
      )}
      role="status"
      aria-label={`Overall status: ${current.label}`}
    >
      <StatusDot state={current.monitorState} size="md" aria-hidden />
      <span>{current.label}</span>
    </div>
  );
}
