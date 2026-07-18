import Link from "next/link";

import { StatusDot } from "@/components/monitors/status-dot";

export function IncidentEmpty({ filtered = false }: { filtered?: boolean }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-[var(--border-strong)] px-6 py-12">
      <div className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
        <StatusDot state="UP" aria-label="Operational" />
        {filtered ? (
          <span>No incidents match this filter</span>
        ) : (
          <span>
            No incidents yet. Add monitors in{" "}
            <Link href="/settings" className="text-[var(--fg)] hover:underline">
              Settings
            </Link>{" "}
            to start checking.
          </span>
        )}
      </div>
    </div>
  );
}
