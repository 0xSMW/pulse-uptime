import Link from "next/link"

import type { HealthWarning } from "@/lib/monitoring/types"

export type { HealthWarning }

export function HealthBanner({
  warnings,
  canOpenSystem,
}: {
  warnings: HealthWarning[]
  canOpenSystem: boolean
}) {
  if (warnings.length === 0) {
    return null
  }

  return (
    <section
      aria-label="System health warning"
      className="mb-6 flex gap-3 rounded-lg border border-[color-mix(in_srgb,var(--verifying)_40%,transparent)] bg-[var(--verifying-bg)] px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="mt-1.5 size-2.5 shrink-0 rounded-full bg-[var(--verifying)]"
      />
      <div className="min-w-0 flex-1">
        <ul className="space-y-1.5">
          {warnings.map((warning) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"
              key={warning.code}
            >
              <span className="min-w-0 break-words font-medium text-[var(--verifying-text)] text-sm">
                {warning.message}
              </span>
              {canOpenSystem ? (
                <Link
                  className="shrink-0 text-[var(--fg-muted)] text-xs underline-offset-2 transition-colors duration-150 hover:text-[var(--fg)] hover:underline"
                  href="/settings/system"
                >
                  {warning.action}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
        {canOpenSystem ? null : (
          <p className="mt-1.5 text-[var(--fg-muted)] text-xs">
            Ask an admin to check System settings
          </p>
        )}
      </div>
    </section>
  )
}
