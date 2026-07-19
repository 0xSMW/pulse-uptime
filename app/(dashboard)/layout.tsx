import { redirect } from "next/navigation";

import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { CommandPaletteProvider } from "@/components/dashboard/command-palette";
import { SettingsReturnTracker } from "@/components/dashboard/settings-return-tracker";
import { TimezoneServerSync } from "@/components/dashboard/timezone-provider";
import { TopNav } from "@/components/dashboard/top-nav";
import { getCurrentSession } from "@/lib/auth/session";
import { listCommandPaletteMonitors } from "@/lib/monitoring/queries";
import { listCommandPaletteIncidents } from "@/lib/reporting/queries/incidents";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The session check must complete before children render; otherwise
  // protected content could stream to unauthenticated clients.
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  if (!session.onboardingCompletedAt) redirect("/onboarding");
  // Not awaited: the palette overlay resolves these with use(), so palette
  // data never blocks first paint.
  const monitorsPromise = listCommandPaletteMonitors()
    .then((monitors) => monitors.map(({ id, name, state, lastLatencyMs }) => ({ id, name, state, lastLatencyMs })))
    .catch(() => []);
  const incidentsPromise = listCommandPaletteIncidents()
    .then((incidents) => incidents.map(({ id, monitorId, monitorName, openedAt, openingFailure }) => ({
      id,
      monitorId,
      monitorName,
      openedAt,
      cause: openingFailure,
    })))
    .catch(() => []);

  return (
    <CommandPaletteProvider monitorsPromise={monitorsPromise} incidentsPromise={incidentsPromise}>
      <div className="min-h-screen">
        <SettingsReturnTracker />
        <TimezoneServerSync timezone={session.timezone} />
        <AutoRefresh intervalMs={60_000} />
        <TopNav email={session.email} />
        <main className="mx-auto max-w-[1200px] px-6 py-8 lg:px-8">{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
