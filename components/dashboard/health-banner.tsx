import { Button } from "@/components/ui/button";
import type { HealthWarning } from "@/lib/monitoring/types";

export type { HealthWarning };

export function HealthBanner({ warnings }: { warnings: HealthWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <section
      aria-label="System health warning"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)] px-4 py-3 sm:flex-row sm:items-center"
    >
      <span className="size-2.5 shrink-0 rounded-full bg-[var(--verifying)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--verifying-text)]">{warnings[0]?.message}</p>
        {warnings.length > 1 ? (
          <p className="mt-0.5 text-xs text-[var(--fg-muted)]">{warnings.length - 1} more checks need attention</p>
        ) : null}
      </div>
      <Button variant="tertiary" size="sm" className="self-start px-2 text-xs text-[var(--fg-muted)] sm:self-auto">
        {warnings[0]?.action}
      </Button>
    </section>
  );
}
