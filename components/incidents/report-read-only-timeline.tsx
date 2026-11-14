"use client"

import useSWRInfinite from "swr/infinite"

import {
  type ApiEnvelope,
  apiRequest,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"

import { IncidentTime } from "./incident-time"
import { ReportStatusChip } from "./report-badges"
import { messageForReportError } from "./report-errors"
import type { ReportData, ReportUpdateData } from "./report-status"

type UpdatesPage = ApiEnvelope<ReportUpdateData[]> & {
  meta?: { nextCursor?: string | null }
}

const OLDER_PAGE_LIMIT = 50

function olderUpdatesUrl(reportId: string, cursor: string): string {
  return `/api/v1/status-reports/${encodeURIComponent(reportId)}/updates?cursor=${encodeURIComponent(cursor)}&limit=${OLDER_PAGE_LIMIT}`
}

function fetchUpdatesPage(url: string): Promise<UpdatesPage> {
  return apiRequest<UpdatesPage>(url)
}

/**
 * Viewer timeline, newest first. The server renders the first page. Older
 * pages load on request through the reports:read updates API.
 */
export function ReportReadOnlyTimeline({
  report,
}: {
  report: Pick<
    ReportData,
    "id" | "updates" | "updatesCount" | "updatesNextCursor"
  >
}) {
  const firstCursor = report.updatesNextCursor ?? null
  // Size starts at 0, so nothing is fetched until Load older is pressed.
  const { data, error, isValidating, size, setSize } =
    useSWRInfinite<UpdatesPage>(
      (index: number, previous: UpdatesPage | null) => {
        const cursor = index === 0 ? firstCursor : previous?.meta?.nextCursor
        return cursor ? olderUpdatesUrl(report.id, cursor) : null
      },
      fetchUpdatesPage,
      { initialSize: 0, revalidateFirstPage: false, revalidateOnFocus: false }
    )
  const pages = data ?? []
  const lastPage = pages.at(-1)
  const nextCursor = lastPage
    ? (lastPage.meta?.nextCursor ?? null)
    : firstCursor
  const loadingOlder = size > pages.length && (isValidating || !error)

  const seen = new Set<string>()
  const updates: ReportUpdateData[] = []
  for (const update of [
    ...report.updates,
    ...pages.flatMap((page) => page.data),
  ]) {
    if (!seen.has(update.id)) {
      seen.add(update.id)
      updates.push(update)
    }
  }
  const updatesCount = Math.max(
    report.updatesCount ?? report.updates.length,
    updates.length
  )

  return (
    <section
      aria-labelledby="report-timeline-title"
      className="rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]"
    >
      <h2
        className="font-semibold text-sm tracking-[-0.28px]"
        id="report-timeline-title"
      >
        Update Timeline
      </h2>
      <ul className="mt-4 space-y-4">
        {updates.map((update) => (
          <li
            className="rounded-[8px] border border-[var(--border-strong)] p-4"
            key={update.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <ReportStatusChip status={update.status} />
              <span className="font-data text-[var(--fg-muted)] text-xs">
                <IncidentTime value={update.publishedAt} />
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words font-data text-[13px]">
              {update.markdown}
            </p>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <div className="mt-4 flex flex-col items-center gap-2 border-[var(--border)] border-t pt-4">
          <p className="text-[var(--fg-muted)] text-xs">
            Latest {updates.length} of {updatesCount} updates
          </p>
          {error ? (
            <p
              className="min-w-0 break-words text-[13px] text-[var(--down-text)]"
              role="alert"
            >
              {messageForReportError(error)}
            </p>
          ) : null}
          <Button
            className="px-2.5"
            disabled={loadingOlder}
            onClick={() => void setSize(pages.length + 1)}
            size="sm"
            variant="secondary"
          >
            {loadingOlder ? "Loading…" : "Load older"}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
