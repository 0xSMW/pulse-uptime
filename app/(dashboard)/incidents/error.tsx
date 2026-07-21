"use client"

import { Button } from "@/components/ui/button"

export default function IncidentsError({
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return (
    <div
      className="rounded-xl border border-[var(--border-strong)] p-6"
      role="alert"
    >
      <h1 className="font-semibold text-base">Incidents unavailable</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Incident history could not be loaded. Try again.
      </p>
      <Button className="mt-4" onClick={reset} variant="secondary">
        Retry
      </Button>
    </div>
  )
}
