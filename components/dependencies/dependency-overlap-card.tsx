import { ExternalLink } from "lucide-react"

import type { DependencyIncidentOverlap } from "@/components/incidents/types"

/**
 * Neutral timing sentence for one dependency overlap, per
 * Docs/Specs/DEPENDENCY-MONITORING.md "Incident correlation": timing and source
 * only, never a causal conclusion, and never the words "root cause",
 * "caused by", or "confirmed cause". `offsetSeconds` is providerStartedAt
 * minus the monitor incident's openedAt (see lib/dependencies/overlap.ts):
 * negative means the provider incident started first. Exported for tests.
 */
export function formatOverlapTiming(offsetSeconds: number): string {
  const minutes = Math.round(Math.abs(offsetSeconds) / 60)
  if (minutes === 0) {
    return "Provider incident began the same minute as this outage"
  }
  const unit = minutes === 1 ? "minute" : "minutes"
  return offsetSeconds < 0
    ? `Provider incident began ${minutes} ${unit} before this outage`
    : `Provider incident began ${minutes} ${unit} after this outage`
}

export function DependencyOverlapCard({
  overlaps,
}: {
  overlaps: readonly DependencyIncidentOverlap[]
}) {
  if (overlaps.length === 0) {
    return null
  }
  return (
    <section
      aria-labelledby="dependency-overlap-title"
      className="rounded-xl border border-[var(--border)] p-4"
    >
      <h3 className="font-medium text-[13px]" id="dependency-overlap-title">
        Possible dependency overlap
      </h3>
      {/* Allow several overlapping dependencies without picking a winner, per
          the spec's "Incident correlation" requirements. */}
      <ul className="mt-3 space-y-3">
        {overlaps.map((overlap) => (
          <li
            className="border-[var(--border)] border-t pt-3 first:border-t-0 first:pt-0"
            key={overlap.incidentId}
          >
            <p className="font-medium text-[13px]">{overlap.dependencyName}</p>
            <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
              {formatOverlapTiming(overlap.offsetSeconds)}
            </p>
            {overlap.canonicalUrl ? (
              <a
                className="mt-1 inline-flex items-center gap-1 text-[13px] text-[var(--fg)] transition-opacity duration-150 hover:opacity-70"
                href={overlap.canonicalUrl}
                rel="noreferrer"
                target="_blank"
              >
                View Provider Incident
                <ExternalLink aria-hidden className="size-3.5" />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
