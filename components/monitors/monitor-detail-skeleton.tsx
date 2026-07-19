import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/monitors/status-badge";
import type { MonitorIdentity } from "@/lib/reporting/queries/monitors";

// Shared by loading.tsx (identity unknown) and the page's Suspense fallback
// (identity known), so the two loading stages never shift against each other.
// Heights mirror the real page: stat cards 122px, response-time card is
// header plus 220px chart, Configuration card closes the page.
export function MonitorDetailSkeleton({ identity }: { identity?: MonitorIdentity }) {
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
              {identity ? (
                <>
                  <h1 className="text-xl font-semibold tracking-[-0.02em]">{identity.name}</h1>
                  <StatusBadge state={identity.state} />
                </>
              ) : (
                <>
                  <div className="h-7 w-52 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
                  <div className="h-6 w-16 animate-pulse rounded-full bg-[var(--chip-bg)]" aria-hidden />
                </>
              )}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[13px] text-[var(--fg-muted)]">
              <span className="h-5 w-10 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
              {identity ? (
                <>
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
                </>
              ) : (
                <span className="h-5 w-72 max-w-full animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
              )}
            </div>
          </div>
          <div className="h-10 w-32 animate-pulse rounded-lg bg-[var(--chip-bg)]" aria-hidden />
        </div>
      </header>
      <div className="grid animate-pulse grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-[122px] rounded-xl bg-[var(--chip-bg)]" />
        ))}
      </div>
      {identity && identity.state === "DOWN" ? (
        <div className="h-[74px] animate-pulse rounded-xl bg-[var(--chip-bg)]" aria-hidden />
      ) : null}
      <div className="h-48 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-[326px] animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="grid animate-pulse gap-6 xl:grid-cols-2">
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
      </div>
      <div className="h-48 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
