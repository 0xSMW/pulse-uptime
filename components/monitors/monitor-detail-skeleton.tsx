import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/monitors/status-badge";
import type { MonitorIdentity } from "@/lib/reporting/queries/monitors";

// Streaming fallback for the monitor detail island: the identity (name, URL,
// state) is real so the header never flashes placeholder text; everything that
// waits on rollup/incident queries shimmers at its final dimensions.
export function MonitorDetailSkeleton({ identity }: { identity: MonitorIdentity }) {
  const state = identity.state;
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading monitor details">
      <header>
        <Link
          href="/"
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Overview
        </Link>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-[-0.02em]">{identity.name}</h1>
              <StatusBadge state={state} />
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[13px] text-[var(--fg-muted)]">
              <span className="h-5 w-10 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
              <a
                href={identity.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate hover:text-[var(--fg)] hover:underline"
                title={identity.url}
              >
                {identity.url}
              </a>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </div>
          </div>
          <div className="h-10 w-32 animate-pulse rounded-lg bg-[var(--chip-bg)]" aria-hidden />
        </div>
      </header>
      <div className="grid animate-pulse grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 rounded-xl bg-[var(--chip-bg)]" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-72 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="grid animate-pulse gap-6 xl:grid-cols-2">
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
      </div>
    </div>
  );
}
