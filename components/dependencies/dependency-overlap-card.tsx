import { ExternalLink } from "lucide-react";

import type { DependencyIncidentOverlap } from "@/components/incidents/types";

/**
 * Neutral timing sentence for one dependency overlap, per
 * Docs/DEPENDENCY-MONITORING.md "Incident correlation": timing and source
 * only, never a causal conclusion, and never the words "root cause",
 * "caused by", or "confirmed cause". `offsetSeconds` is providerStartedAt
 * minus the monitor incident's openedAt (see lib/dependencies/overlap.ts):
 * negative means the provider incident started first. Exported for tests.
 */
export function formatOverlapTiming(offsetSeconds: number): string {
  const minutes = Math.round(Math.abs(offsetSeconds) / 60);
  if (minutes === 0) return "Provider incident began the same minute as this outage";
  const unit = minutes === 1 ? "minute" : "minutes";
  return offsetSeconds < 0
    ? `Provider incident began ${minutes} ${unit} before this outage`
    : `Provider incident began ${minutes} ${unit} after this outage`;
}

export function DependencyOverlapCard({ overlaps }: { overlaps: readonly DependencyIncidentOverlap[] }) {
  if (overlaps.length === 0) return null;
  return (
    <section aria-labelledby="dependency-overlap-title" className="rounded-xl border border-[var(--border)] p-4">
      <h3 id="dependency-overlap-title" className="text-[13px] font-medium">Possible dependency overlap</h3>
      {/* Allow several overlapping dependencies without picking a winner, per
          the spec's "Incident correlation" requirements. */}
      <ul className="mt-3 space-y-3">
        {overlaps.map((overlap) => (
          <li key={overlap.incidentId} className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
            <p className="text-[13px] font-medium">{overlap.dependencyName}</p>
            <p className="mt-1 text-[13px] text-[var(--fg-muted)]">{formatOverlapTiming(overlap.offsetSeconds)}</p>
            {overlap.canonicalUrl ? (
              <a
                href={overlap.canonicalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[13px] text-[var(--fg)] hover:underline"
              >
                View Provider Incident
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
