import { redirect } from "next/navigation";

import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { CommandPaletteProvider } from "@/components/dashboard/command-palette";
import { SettingsReturnTracker } from "@/components/dashboard/settings-return-tracker";
import { TopNav } from "@/components/dashboard/top-nav";
import { getCurrentSession } from "@/lib/auth/session";
import { listCommandPaletteMonitors } from "@/lib/monitoring/queries";
import { listCommandPaletteIncidents } from "@/lib/reporting/queries/incidents";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Auth barrier stays ahead of children on purpose: no protected bytes can
  // stream before the session check resolves.
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  if (!session.onboardingCompletedAt) redirect("/onboarding");
  // Deliberately not awaited: streamed to the palette overlay, which resolves
  // them with use() — palette data never blocks first paint.
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
        <AutoRefresh intervalMs={60_000} />
        <TopNav email={session.email} />
        <main className="mx-auto max-w-[1200px] px-6 py-8 lg:px-8">{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
