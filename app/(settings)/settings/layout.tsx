import { redirect } from "next/navigation";

import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { TimezoneServerSync } from "@/components/dashboard/timezone-provider";
import { SettingsDirtyProvider } from "@/components/settings/settings-dirty";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { getCurrentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  if (!session.onboardingCompletedAt) redirect("/onboarding");

  return (
    <SettingsDirtyProvider>
      <TimezoneServerSync timezone={session.timezone} />
      <div className="min-h-dvh md:flex">
        <AutoRefresh />
        <SettingsSidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[820px] px-6 py-8 md:px-10 md:py-12">{children}</div>
        </main>
      </div>
    </SettingsDirtyProvider>
  );
}
