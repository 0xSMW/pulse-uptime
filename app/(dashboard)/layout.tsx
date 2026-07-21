import { redirect } from "next/navigation"

import { AutoRefresh } from "@/components/dashboard/auto-refresh"
import { CommandPaletteProvider } from "@/components/dashboard/command-palette"
import { SettingsReturnTracker } from "@/components/dashboard/settings-return-tracker"
import { TimezoneServerSync } from "@/components/dashboard/timezone-provider"
import { TopNav } from "@/components/dashboard/top-nav"
import { findAccountProfile } from "@/lib/api/account"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { listDependenciesForDashboard } from "@/lib/dependencies/queries"
import { listCommandPaletteMonitors } from "@/lib/monitoring/queries"
import { listCommandPaletteIncidents } from "@/lib/reporting/queries/incidents"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // The session check must complete before children render; otherwise
  // protected content could stream to unauthenticated clients.
  const session = await authenticateCurrentSession()
  if (!session) {
    redirect("/onboarding")
  }
  if (!session.onboardingCompletedAt) {
    redirect("/onboarding")
  }
  // Identity for the user menu. The session query intentionally omits name and
  // avatar, so load them from the profile here.
  const profile = await findAccountProfile(session.userId)
  // Not awaited: the palette overlay resolves these with use(), so palette
  // data never blocks first paint.
  const monitorsPromise = listCommandPaletteMonitors()
    .then((monitors) =>
      monitors.map(({ id, name, state, lastLatencyMs }) => ({
        id,
        name,
        state,
        latestLatencyMs: lastLatencyMs,
      }))
    )
    .catch(() => [])
  const dependenciesPromise = listDependenciesForDashboard()
    .then((dependencies) =>
      dependencies.map(
        ({ id, name, state, pendingFirstPoll, provider, componentLabel }) => ({
          id,
          name,
          state,
          pending: pendingFirstPoll,
          provider,
          componentLabel,
        })
      )
    )
    .catch(() => [])
  const incidentsPromise = listCommandPaletteIncidents()
    .then((incidents) =>
      incidents.map(
        ({ id, monitorId, monitorName, openedAt, openingFailure }) => ({
          id,
          monitorId,
          monitorName,
          openedAt,
          cause: openingFailure,
        })
      )
    )
    .catch(() => [])

  return (
    <CommandPaletteProvider
      dependenciesPromise={dependenciesPromise}
      incidentsPromise={incidentsPromise}
      monitorsPromise={monitorsPromise}
    >
      <div className="min-h-screen">
        <SettingsReturnTracker />
        <TimezoneServerSync timezone={session.timezone} />
        <AutoRefresh intervalMs={60_000} />
        <TopNav
          avatarImageId={profile?.avatarImageId ?? null}
          email={session.email}
          name={profile?.name ?? null}
        />
        <main className="mx-auto max-w-[1200px] px-6 py-8 lg:px-8">
          {children}
        </main>
      </div>
    </CommandPaletteProvider>
  )
}
