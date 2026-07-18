import { DatabaseHealthCard } from "@/components/settings/database-health";
import { getSystemSettings } from "@/lib/reporting/queries/settings";

export default async function SystemSettingsPage() {
  const { databaseHealth, databaseHealthError } = await getSystemSettings();

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">System</h1>
      <DatabaseHealthCard initialData={databaseHealth} initialError={databaseHealthError} />
    </>
  );
}
