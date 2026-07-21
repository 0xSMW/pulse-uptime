"use client"

import { useState } from "react"

import {
  formatStatusTimestamp,
  timezoneOffsetLabel,
} from "@/lib/status-page/display"
import {
  REPORT_STATUS_LABELS,
  type ReportUpdateStatus,
} from "@/lib/status-reports/domain"

import { loadPublicReportUpdates } from "./load-public-report-updates"

interface PublicUpdate {
  id: string
  status: ReportUpdateStatus
  html: string
  publishedAt: string
  createdAt: string
}

/**
 * Public report timeline with optional "Load older" for histories past the
 * first detail page. Older pages share listStatusReportUpdates with the
 * authenticated GET .../updates route.
 */
export function PublicReportUpdates({
  reportId,
  initialUpdates,
  initialNextCursor,
  timezone,
}: {
  reportId: string
  initialUpdates: PublicUpdate[]
  initialNextCursor: string | null
  timezone: string
}) {
  const [updates, setUpdates] = useState(initialUpdates)
  const [nextCursor, setNextCursor] = useState(initialNextCursor)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadOlder() {
    if (!nextCursor || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const page = await loadPublicReportUpdates(reportId, nextCursor)
      setUpdates((current) => {
        const seen = new Set(current.map((update) => update.id))
        return [
          ...current,
          ...page.data.filter((update) => !seen.has(update.id)),
        ]
      })
      setNextCursor(page.nextCursor)
    } catch {
      setError("Could not load older updates")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="updates-heading" className="mt-6">
      <h2 className="font-semibold text-sm" id="updates-heading">
        Updates
      </h2>
      <ol className="mt-4 space-y-5 border-[var(--border)] border-l pl-5">
        {updates.map((update) => (
          <li className="relative" key={update.id}>
            <span
              aria-hidden
              className="absolute top-1.5 -left-[23px] size-1.5 rounded-full bg-[var(--border-strong)]"
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-semibold text-[13px]">
                {REPORT_STATUS_LABELS[update.status]}
              </h3>
              <time
                className="font-data text-[var(--fg-faint)] text-xs"
                dateTime={update.publishedAt}
              >
                {formatStatusTimestamp(update.publishedAt, timezone)}{" "}
                {timezoneOffsetLabel(timezone, new Date(update.publishedAt))}
              </time>
            </div>
            <div
              className="mt-1.5 space-y-2 text-[13px] text-[var(--fg-muted)] leading-[19px] [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-data [&_code]:text-xs"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: html is pre-rendered by renderRestrictedMarkdown on the server, escaped and limited to whitelisted tags
              dangerouslySetInnerHTML={{ __html: update.html }}
            />
          </li>
        ))}
      </ol>
      {nextCursor ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <button
            className="rounded-[6px] border border-[var(--border-strong)] px-3 py-1.5 text-[13px] text-[var(--fg)] transition-colors hover:bg-[var(--hover)] disabled:opacity-50"
            disabled={busy}
            onClick={() => void loadOlder()}
            type="button"
          >
            {busy ? "Loading…" : "Load older"}
          </button>
          {error ? (
            <p className="text-[13px] text-[var(--down-text)]" role="status">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
