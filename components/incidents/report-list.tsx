import Link from "next/link"

import { StatusDot } from "@/components/monitors/status-dot"

import { IncidentTime } from "./incident-time"
import { ReportDraftBadge, ReportTypeChip } from "./report-badges"
import { reportsHref } from "./report-filters"
import { ReportRowActions } from "./report-row-actions"
import {
  formatUpdateCount,
  REPORT_STATUS_LABELS,
  type ReportListRowData,
  type ReportListState,
  type ReportListType,
  reportDotState,
} from "./report-status"

export function ReportList({ reports }: { reports: ReportListRowData[] }) {
  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
      {reports.map((report) => {
        const latest = report.latestUpdate
        // relative on the li contains the title link's after:inset-0
        // overlay, which stretches the click target to the whole row.
        // List items are reliable containing blocks, unlike table rows.
        return (
          <li
            className="relative flex items-center gap-4 px-6 py-4 hover:bg-[var(--hover)]"
            key={report.id}
          >
            <StatusDot
              aria-label={REPORT_STATUS_LABELS[report.currentStatus]}
              state={reportDotState(report.currentStatus)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  className="truncate font-medium text-sm tracking-[-0.28px] after:absolute after:inset-0"
                  href={`/incidents/reports/${encodeURIComponent(report.id)}`}
                >
                  {report.title}
                </Link>
                {report.publishedAt === null ? <ReportDraftBadge /> : null}
                {report.type === "maintenance" ? <ReportTypeChip /> : null}
              </div>
              <p className="mt-1 flex flex-wrap gap-x-2 text-[var(--fg-muted)] text-xs">
                <span>{REPORT_STATUS_LABELS[report.currentStatus]}</span>
                <span aria-hidden>·</span>
                <span>{formatUpdateCount(report.updatesCount)}</span>
                {latest ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="whitespace-nowrap font-data">
                      Updated <IncidentTime value={latest.publishedAt} />
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <ReportRowActions reportId={report.id} title={report.title} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Cursor-following pagination, matching the filter-link pattern: "Older
 * reports" walks forward via nextCursor. "Newer reports" returns to the first
 * page whenever a cursor is active.
 */
export function ReportListPagination({
  state,
  type,
  cursor,
  nextCursor,
}: {
  state: ReportListState
  type: ReportListType
  cursor: string | null
  nextCursor: string | null
}) {
  if (!(cursor || nextCursor)) {
    return null
  }
  return (
    <nav
      aria-label="Reports pagination"
      className="mt-4 flex items-center justify-between text-[13px]"
    >
      {cursor ? (
        <Link
          className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href={reportsHref(state, type)}
        >
          ← Newer reports
        </Link>
      ) : (
        <span aria-hidden />
      )}
      {nextCursor ? (
        <Link
          className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          href={reportsHref(state, type, nextCursor)}
        >
          Older reports →
        </Link>
      ) : null}
    </nav>
  )
}

export function ReportsEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-[var(--border-strong)] px-6 py-12">
      <div className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
        <StatusDot aria-label="Operational" state="UP" />
        {filtered ? (
          <span>No reports match this filter</span>
        ) : (
          <span>
            No status reports yet.{" "}
            <Link
              className="text-[var(--fg)] transition-opacity duration-150 hover:opacity-70"
              href="/incidents/reports/new"
            >
              Create one
            </Link>{" "}
            to narrate an incident or maintenance window.
          </span>
        )}
      </div>
    </div>
  )
}
