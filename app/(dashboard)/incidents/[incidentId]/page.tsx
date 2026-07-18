import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { IncidentEventTrail } from "@/components/incidents/incident-event-trail";
import { formatIncidentDuration } from "@/components/incidents/incident-format";
import { IncidentTime } from "@/components/incidents/incident-time";
import { IncidentStatus } from "@/components/incidents/incident-status";
import { NotificationSummary } from "@/components/incidents/notification-summary";
import type { IncidentDetail } from "@/components/incidents/types";
import { getIncidentDetail } from "@/lib/reporting/queries/incidents";

export default async function IncidentDetailPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  const incident: IncidentDetail | null = await getIncidentDetail(incidentId);
  if (!incident) notFound();

  const stats = [
    { label: "Started", value: <IncidentTime value={incident.openedAt} /> },
    { label: "Resolved", value: incident.resolvedAt ? <IncidentTime value={incident.resolvedAt} /> : "Ongoing" },
    { label: "Duration", value: formatIncidentDuration(incident.durationSeconds) },
  ];

  return (
    <>
      <Link href="/incidents" className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Incidents
      </Link>

      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{incident.monitorName}</h1>
        <IncidentStatus ongoing={!incident.resolvedAt} />
      </header>

      <dl className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]">
        {stats.map((stat) => (
          <div key={stat.label} className="border-b border-[var(--border)] px-6 py-5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <dt className="text-xs text-[var(--fg-muted)]">{stat.label}</dt>
            <dd className="mt-1 font-data text-[13px]">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="incident-cause-title" className="mb-6 rounded-xl border border-[var(--border-strong)] p-6 shadow-[var(--card-shadow)]">
        <h2 id="incident-cause-title" className="text-xs font-medium text-[var(--fg-muted)]">Opening Failure</h2>
        <p className="mt-2 font-data text-[13px]">{incident.openingFailure}</p>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs text-[var(--fg-muted)]">
          <span>Status <span className="font-data text-[var(--fg)]">{incident.status ?? "—"}</span></span>
          <span className="inline-flex gap-2">Notifications <NotificationSummary summary={incident.notificationSummary} /></span>
        </div>
      </section>

      <IncidentEventTrail events={incident.events} />
    </>
  );
}
