import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export type HealthWarning = {
  code: string;
  message: string;
  action: string;
};

export function HealthBanner({ warnings }: { warnings: HealthWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <section
      aria-label="System health warning"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--verifying)] bg-[var(--bg)] px-4 py-3 sm:flex-row sm:items-center"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--verifying-bg)] text-[var(--verifying-text)]">
        <AlertTriangle className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--fg)]">{warnings[0]?.message}</p>
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
