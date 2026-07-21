import { ArrowLeft, ExternalLink } from "lucide-react"
import Link from "next/link"

import { StatusBadge } from "@/components/monitors/status-badge"
import type { MonitorIdentity } from "@/lib/reporting/queries/monitors"

// Shared by loading.tsx (identity unknown) and the page's Suspense fallback
// (identity known), so the two loading stages never shift against each other.
// Heights mirror the real page: stat cards 122px, response-time card is
// header plus 220px chart, Configuration card closes the page.
export function MonitorDetailSkeleton({
  identity,
}: {
  identity?: MonitorIdentity
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading monitor details"
      className="space-y-6"
      role="status"
    >
      <header>
        <Link
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href="/"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Overview
        </Link>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              {identity ? (
                <>
                  <h1 className="font-semibold text-xl tracking-[-0.02em]">
                    {identity.name}
                  </h1>
                  <StatusBadge state={identity.state} />
                </>
              ) : (
                <>
                  <div
                    aria-hidden
                    className="h-7 w-52 animate-pulse rounded bg-[var(--chip-bg)]"
                  />
                  <div
                    aria-hidden
                    className="h-6 w-16 animate-pulse rounded-full bg-[var(--chip-bg)]"
                  />
                </>
              )}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 font-data text-[13px] text-[var(--fg-muted)]">
              <span
                aria-hidden
                className="h-5 w-10 animate-pulse rounded bg-[var(--chip-bg)]"
              />
              {identity ? (
                <>
                  <a
                    className="min-w-0 truncate transition-colors duration-150 hover:text-[var(--fg)]"
                    href={identity.url}
                    rel="noreferrer"
                    target="_blank"
                    title={identity.url}
                  >
                    {identity.url}
                  </a>
                  <ExternalLink aria-hidden className="size-3 shrink-0" />
                </>
              ) : (
                <span
                  aria-hidden
                  className="h-5 w-72 max-w-full animate-pulse rounded bg-[var(--chip-bg)]"
                />
              )}
            </div>
          </div>
          <div
            aria-hidden
            className="h-10 w-32 animate-pulse rounded-lg bg-[var(--chip-bg)]"
          />
        </div>
      </header>
      <div className="grid animate-pulse grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            className="h-[122px] rounded-xl bg-[var(--chip-bg)]"
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list that never reorders
            key={index}
          />
        ))}
      </div>
      {identity && identity.state === "DOWN" ? (
        <div
          aria-hidden
          className="h-[74px] animate-pulse rounded-xl bg-[var(--chip-bg)]"
        />
      ) : null}
      <div className="h-48 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-[326px] animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="grid animate-pulse gap-6 xl:grid-cols-2">
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
        <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
      </div>
      <div className="h-48 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
    </div>
  )
}
