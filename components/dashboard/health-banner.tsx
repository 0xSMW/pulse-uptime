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
      className="mb-6 flex flex-col gap-4 rounded-xl border border-[var(--verifying)] bg-[var(--verifying-bg)] px-5 py-4 text-[var(--verifying-text)] sm:flex-row sm:items-center"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{warnings[0]?.message}</p>
        {warnings.length > 1 ? (
          <p className="mt-0.5 text-xs">{warnings.length - 1} more checks need attention</p>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" className="border-current bg-transparent">
        {warnings[0]?.action}
      </Button>
    </section>
  );
}
