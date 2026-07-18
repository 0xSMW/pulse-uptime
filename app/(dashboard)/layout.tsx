import { redirect } from "next/navigation";

import { CommandPaletteProvider } from "@/components/dashboard/command-palette";
import { TopNav } from "@/components/dashboard/top-nav";
import { getCurrentSession } from "@/lib/auth/session";
import { listCommandPaletteMonitors } from "@/lib/monitoring/queries";
import { listIncidents } from "@/lib/reporting/queries/incidents";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  if (!session.onboardingCompletedAt) redirect("/onboarding");
  const [monitors, incidents] = await Promise.all([
    listCommandPaletteMonitors(),
    listIncidents("ongoing"),
  ]);

  return (
    <CommandPaletteProvider
      monitors={monitors.map(({ id, name, state, lastLatencyMs }) => ({ id, name, state, lastLatencyMs }))}
      incidents={incidents.map(({ id, monitorId, monitorName, openedAt, openingFailure }) => ({
        id,
        monitorId,
        monitorName,
        openedAt,
        cause: openingFailure,
      }))}
    >
      <div className="min-h-screen">
        <TopNav email={session.email} />
        <main className="mx-auto max-w-[1200px] px-6 py-8 lg:px-8">{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
