import { AccessSettings } from "@/components/settings/access-settings";
import { getAccessSettings } from "@/lib/reporting/queries/settings";

export default async function AccessSettingsPage() {
  const data = await getAccessSettings();

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Access</h1>
      <AccessSettings data={data} />
    </>
  );
}
