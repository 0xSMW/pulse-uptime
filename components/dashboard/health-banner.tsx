import { Button } from "@/components/ui/button"
import type { HealthWarning } from "@/lib/monitoring/types"

export type { HealthWarning }

export function HealthBanner({ warnings }: { warnings: HealthWarning[] }) {
  if (warnings.length === 0) {
    return null
  }

  return (
    <section
      aria-label="System health warning"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)] px-4 py-3 sm:flex-row sm:items-center"
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full bg-[var(--verifying)]"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[var(--verifying-text)] text-sm">
          {warnings[0]?.message}
        </p>
        {warnings.length > 1 ? (
          <p className="mt-0.5 text-[var(--fg-muted)] text-xs">
            {warnings.length - 1} more checks need attention
          </p>
        ) : null}
      </div>
      <Button
        className="self-start px-2 text-[var(--fg-muted)] text-xs sm:self-auto"
        size="sm"
        variant="tertiary"
      >
        {warnings[0]?.action}
      </Button>
    </section>
  )
}
