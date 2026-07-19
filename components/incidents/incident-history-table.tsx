import Link from "next/link";

import { formatIncidentDuration } from "@/components/incidents/incident-format";
import { IncidentTime } from "@/components/incidents/incident-time";
import { IncidentStatus } from "@/components/incidents/incident-status";
import { NotificationSummary } from "@/components/incidents/notification-summary";
import type { IncidentSummary } from "@/components/incidents/types";
import { WriteReportButton } from "@/components/incidents/write-report-button";

export function IncidentHistoryTable({ incidents }: { incidents: IncidentSummary[] }) {
  return (
    <section aria-labelledby="incident-history-title">
      <h2 id="incident-history-title" className="mb-3 text-sm font-semibold tracking-[-0.28px]">
        History
      </h2>
      <div className="hide-scrollbar overflow-x-auto rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
        <table className="w-full min-w-[600px] border-collapse text-left text-[13px] md:min-w-[760px] lg:min-w-[940px]">
          <thead className="text-xs text-[var(--fg-muted)]">
            <tr className="h-10 border-b border-[var(--border)]">
              <th className="px-6 font-medium">Monitor</th>
              <th className="px-4 font-medium">State</th>
              <th className="px-4 font-medium">Started</th>
              <th className="incident-hide-resolved px-4 font-medium">Resolved</th>
              <th className="px-4 font-medium">Duration</th>
              {/* Opening Failure already carries the HTTP status code
                  (failureLabel renders "HTTP <code>"), so there is no
                  separate Status column. */}
              <th className="incident-hide-failure px-4 font-medium">Opening Failure</th>
              <th className="incident-hide-notifications px-4 font-medium">Notifications</th>
              <th className="px-6 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id} className="h-12 border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]">
                {/* relative on this cell contains the link's after:inset-0
                    overlay. Table rows are not reliable containing blocks
                    (WebKit ignores position relative on tr), so a row scoped
                    overlay escapes to the page and swallows clicks on the
                    tabs above. */}
                <td className="relative px-6 font-medium">
                  <Link
                    href={`/incidents/${encodeURIComponent(incident.id)}`}
                    className="after:absolute after:inset-0"
                  >
                    {incident.monitorName}
                  </Link>
                </td>
                <td className="px-4"><IncidentStatus ongoing={!incident.resolvedAt} /></td>
                <td className="px-4 font-data whitespace-nowrap"><IncidentTime value={incident.openedAt} /></td>
                <td className="incident-hide-resolved px-4 font-data whitespace-nowrap text-[var(--fg-muted)]">
                  {incident.resolvedAt ? <IncidentTime value={incident.resolvedAt} sameDayOf={incident.openedAt} /> : "—"}
                </td>
                <td className="px-4 font-data whitespace-nowrap">{formatIncidentDuration(incident.durationSeconds)}</td>
                <td className="incident-hide-failure max-w-52 truncate px-4 font-data" title={incident.openingFailure}>
                  {incident.openingFailure}
                </td>
                <td className="incident-hide-notifications px-4"><NotificationSummary summary={incident.notificationSummary} /></td>
                <td className="px-6 text-right"><WriteReportButton incidentId={incident.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        @media (max-width: 960px) { .incident-hide-notifications { display: none; } }
        @media (max-width: 720px) { .incident-hide-resolved, .incident-hide-failure { display: none; } }
      `}</style>
    </section>
  );
}
