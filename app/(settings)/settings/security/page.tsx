import { redirect } from "next/navigation";

import { SecuritySettings } from "@/components/settings/security-settings";
import { getCurrentSession } from "@/lib/auth/session";
import { getSecuritySettings } from "@/lib/reporting/queries/settings";

export default async function SecuritySettingsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  const data = await getSecuritySettings(session.userId, session.sessionId);

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Security</h1>
      <SecuritySettings data={data} />
    </>
  );
}
