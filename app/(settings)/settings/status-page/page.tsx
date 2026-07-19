import { GuardedLink } from "@/components/settings/settings-dirty";
import { StatusPageSettings } from "@/components/settings/status-page-settings";
import { getStatusPageSettings } from "@/lib/reporting/queries/settings";

export default async function StatusPageSettingsPage() {
  const data = await getStatusPageSettings();

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Status page</h1>
        <div className="flex items-center gap-4 text-[13px]">
          <GuardedLink href="/incidents/reports" className="text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline">
            Manage status reports →
          </GuardedLink>
          <GuardedLink href="/status" className="text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline">
            View status page ↗
          </GuardedLink>
        </div>
      </div>
      <StatusPageSettings data={data} />
    </>
  );
}
