import { IncidentEmpty } from "@/components/incidents/incident-empty";
import { IncidentFilters } from "@/components/incidents/incident-filters";
import { IncidentsTabs } from "@/components/incidents/incidents-tabs";
import { IncidentHistoryTable } from "@/components/incidents/incident-history-table";
import { OngoingIncidentCard } from "@/components/incidents/ongoing-incident-card";
import type { IncidentFilter, IncidentSummary } from "@/components/incidents/types";
import { hasConfiguredMonitors, listIncidents } from "@/lib/reporting/queries/incidents";

function parseFilter(value: string | string[] | undefined): IncidentFilter {
  const filter = Array.isArray(value) ? value[0] : value;
  return filter === "ongoing" || filter === "resolved" ? filter : "all";
}

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>;
}) {
  const filter = parseFilter((await searchParams).filter);
  const [incidents, hasMonitors]: [IncidentSummary[], boolean] = await Promise.all([
    listIncidents(filter),
    hasConfiguredMonitors(),
  ]);
  const ongoing = incidents.filter((incident) => !incident.resolvedAt);
  const history = incidents.filter((incident) => Boolean(incident.resolvedAt));

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">Incidents</h1>
            <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Endpoint outage history</p>
          </div>
          <IncidentFilters active={filter} />
        </div>
        <IncidentsTabs className="mt-4" />
      </header>

      {incidents.length === 0 ? (
        <IncidentEmpty filtered={filter !== "all"} hasMonitors={hasMonitors} />
      ) : (
        <div className="space-y-8">
          {ongoing.length > 0 ? (
            <section aria-labelledby="ongoing-incidents-title">
              <h2 id="ongoing-incidents-title" className="mb-3 text-sm font-semibold tracking-[-0.28px]">Ongoing</h2>
              <div className="space-y-4">
                {ongoing.map((incident) => <OngoingIncidentCard key={incident.id} incident={incident} />)}
              </div>
            </section>
          ) : null}
          {history.length > 0 ? <IncidentHistoryTable incidents={history} /> : null}
        </div>
      )}
    </>
  );
}
