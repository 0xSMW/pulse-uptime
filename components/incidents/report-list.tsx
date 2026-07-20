import Link from "next/link";

import { StatusDot } from "@/components/monitors/status-dot";

import { IncidentTime } from "./incident-time";
import { ReportDraftBadge, ReportTypeChip } from "./report-badges";
import { reportsHref } from "./report-filters";
import { ReportRowActions } from "./report-row-actions";
import {
  formatUpdateCount,
  REPORT_STATUS_LABELS,
  reportDotState,
  type ReportListRowData,
  type ReportListState,
  type ReportListType,
} from "./report-status";

export function ReportList({ reports }: { reports: ReportListRowData[] }) {
  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
      {reports.map((report) => {
        const latest = report.latestUpdate;
        // relative on the li contains the title link's after:inset-0
        // overlay, which stretches the click target to the whole row.
        // List items are reliable containing blocks, unlike table rows.
        return (
          <li key={report.id} className="relative flex items-center gap-4 px-6 py-4 hover:bg-[var(--hover)]">
            <StatusDot
              state={reportDotState(report.currentStatus)}
              aria-label={REPORT_STATUS_LABELS[report.currentStatus]}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/incidents/reports/${encodeURIComponent(report.id)}`}
                  className="truncate text-sm font-medium tracking-[-0.28px] after:absolute after:inset-0"
                >
                  {report.title}
                </Link>
                {report.publishedAt === null ? <ReportDraftBadge /> : null}
                {report.type === "maintenance" ? <ReportTypeChip /> : null}
              </div>
              <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-[var(--fg-muted)]">
                <span>{REPORT_STATUS_LABELS[report.currentStatus]}</span>
                <span aria-hidden>·</span>
                <span>{formatUpdateCount(report.updatesCount)}</span>
                {latest ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-data whitespace-nowrap">
                      Updated <IncidentTime value={latest.publishedAt} />
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <ReportRowActions reportId={report.id} title={report.title} />
          </li>
        );
      })}
    </ul>
  );
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
  state: ReportListState;
  type: ReportListType;
  cursor: string | null;
  nextCursor: string | null;
}) {
  if (!cursor && !nextCursor) return null;
  return (
    <nav aria-label="Reports pagination" className="mt-4 flex items-center justify-between text-[13px]">
      {cursor ? (
        <Link href={reportsHref(state, type)} className="text-[var(--fg-muted)] hover:text-[var(--fg)]">
          ← Newer reports
        </Link>
      ) : (
        <span aria-hidden />
      )}
      {nextCursor ? (
        <Link href={reportsHref(state, type, nextCursor)} className="text-[var(--fg-muted)] hover:text-[var(--fg)]">
          Older reports →
        </Link>
      ) : null}
    </nav>
  );
}

export function ReportsEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-[var(--border-strong)] px-6 py-12">
      <div className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
        <StatusDot state="UP" aria-label="Operational" />
        {filtered ? (
          <span>No reports match this filter</span>
        ) : (
          <span>
            No status reports yet.{" "}
            <Link href="/incidents/reports/new" className="text-[var(--fg)] transition-opacity duration-150 hover:opacity-70">
              Create one
            </Link>{" "}
            to narrate an incident or maintenance window.
          </span>
        )}
      </div>
    </div>
  );
}
