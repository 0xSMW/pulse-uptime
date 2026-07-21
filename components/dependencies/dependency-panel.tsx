import { DependencyPanelRow } from "@/components/dependencies/dependency-row"
import { listDependenciesForDashboard } from "@/lib/dependencies/queries"

// Server component: hidden entirely when no dependencies exist, per
// Docs/Specs/DEPENDENCY-MONITORING.md "Overview". No uptime percentage anywhere,
// since provider status criteria are subjective and cannot support a
// trustworthy cross-provider availability calculation.
export async function DependencyPanel() {
  const dependencies = await listDependenciesForDashboard()
  if (dependencies.length === 0) {
    return null
  }

  // The Incident column is present only when at least one dependency carries an
  // active incident, so an all-clear table does not reserve an empty column.
  const hasIncidents = dependencies.some((dependency) =>
    Boolean(dependency.activeIncidentTitle)
  )

  return (
    <section aria-labelledby="dependencies-title" className="mt-8">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h2
            className="font-semibold text-xl tracking-[-0.02em]"
            id="dependencies-title"
          >
            Dependencies
          </h2>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            Provider reported
          </p>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
          <thead className="text-[var(--fg-muted)] text-xs">
            <tr className="h-10 border-[var(--border)] border-b">
              <th className="px-6 font-medium">Status</th>
              <th className="px-4 font-medium">Dependency</th>
              <th className="px-4 font-medium">Timeline 24h</th>
              <th className="px-4 font-medium">Provider Updated</th>
              {hasIncidents ? (
                <th className="px-6 font-medium">Incident</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {dependencies.map((dependency) => (
              <DependencyPanelRow
                dependency={dependency}
                key={dependency.id}
                showIncident={hasIncidents}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
