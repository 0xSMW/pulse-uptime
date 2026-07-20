"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatIncidentDuration } from "@/components/incidents/incident-format";
import { IncidentTime } from "@/components/incidents/incident-time";
import { IncidentStatus } from "@/components/incidents/incident-status";
import type { IncidentSummary } from "@/components/incidents/types";

export function OngoingIncidentCard({ incident }: { incident: IncidentSummary }) {
  const [elapsed, setElapsed] = useState(incident.durationSeconds);

  useEffect(() => {
    const updateElapsed = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - new Date(incident.openedAt).getTime()) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 60_000);
    return () => window.clearInterval(timer);
  }, [incident.openedAt]);

  return (
    <article className="rounded-xl border border-[color-mix(in_srgb,var(--down)_40%,transparent)] bg-[var(--down-bg)] p-6 shadow-[var(--card-shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="status-dot-pulse relative size-2.5 shrink-0 rounded-full bg-[var(--down)] text-[var(--down)]" aria-hidden="true" />
          <Link
            href={`/incidents/${encodeURIComponent(incident.id)}`}
            className="truncate text-sm font-semibold tracking-[-0.28px] transition-opacity duration-150 hover:opacity-70"
          >
            {incident.monitorName}
          </Link>
        </div>
        <IncidentStatus ongoing />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 font-data text-xs text-[var(--fg-muted)]">
        <span>Started <IncidentTime value={incident.openedAt} /></span>
        <span aria-label={`Ongoing for ${formatIncidentDuration(elapsed)}`}>
          {formatIncidentDuration(elapsed)} elapsed
        </span>
      </div>
      <p className="mt-3 font-data text-[13px] text-[var(--down-text)]">{incident.openingFailure}</p>
    </article>
  );
}
