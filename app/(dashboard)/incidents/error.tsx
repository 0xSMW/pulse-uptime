"use client";

import { Button } from "@/components/ui/button";

export default function IncidentsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-[var(--border-strong)] p-6">
      <h1 className="text-base font-semibold">Incidents unavailable</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">Incident history could not be loaded. Try again.</p>
      <Button variant="secondary" className="mt-4" onClick={reset}>Retry</Button>
    </div>
  );
}
