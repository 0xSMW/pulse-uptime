import Link from "next/link";

import { IncidentsTabs } from "@/components/incidents/incidents-tabs";
import { ReportFilters } from "@/components/incidents/report-filters";
import { ReportList, ReportListPagination, ReportsEmpty } from "@/components/incidents/report-list";
import type { ReportListState, ReportListType } from "@/components/incidents/report-status";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listStatusReportSummaries, parseStatusReportListQuery } from "@/lib/api/status-reports";

function parseState(value: string | string[] | undefined): ReportListState {
  const state = Array.isArray(value) ? value[0] : value;
  return state === "draft" || state === "ongoing" || state === "resolved" ? state : "all";
}

function parseType(value: string | string[] | undefined): ReportListType {
  const type = Array.isArray(value) ? value[0] : value;
  return type === "incident" || type === "maintenance" ? type : "all";
}

function parseCursorParam(value: string | string[] | undefined): string | null {
  const cursor = Array.isArray(value) ? value[0] : value;
  return cursor ?? null;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[]; type?: string | string[]; cursor?: string | string[] }>;
}) {
  const params = await searchParams;
  const state = parseState(params.state);
  const type = parseType(params.type);
  let cursorParam = parseCursorParam(params.cursor);
  let cursor: { createdAt: Date; id: string } | null = null;
  if (cursorParam) {
    try {
      cursor = parseStatusReportListQuery({ state, type, cursor: cursorParam }).cursor;
    } catch {
      // A malformed cursor falls back to the first page instead of erroring.
      cursorParam = null;
    }
  }
  const { data: reports, nextCursor } = await listStatusReportSummaries({ state, type, cursor, limit: 100 });

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">Incidents</h1>
            <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Status reports published to your status page</p>
          </div>
          <Link href="/incidents/reports/new" className={cn(buttonVariants({ variant: "primary", size: "sm" }), "px-3")}>
            Create Status Report
          </Link>
        </div>
        <IncidentsTabs className="mt-4" />
      </header>

      <div className="mb-4">
        <ReportFilters state={state} type={type} />
      </div>

      {reports.length === 0 ? (
        <ReportsEmpty filtered={state !== "all" || type !== "all"} />
      ) : (
        <ReportList reports={reports} />
      )}
      <ReportListPagination state={state} type={type} cursor={cursorParam} nextCursor={nextCursor} />
    </>
  );
}
