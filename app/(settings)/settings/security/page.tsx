import { redirect } from "next/navigation"

import { SecuritySettings } from "@/components/settings/security-settings"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { getSecuritySettings } from "@/lib/reporting/queries/settings"

export default async function SecuritySettingsPage() {
  const session = await authenticateCurrentSession()
  if (!session) {
    redirect("/onboarding")
  }
  const data = await getSecuritySettings(session.userId, session.sessionId)

  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">
        Security
      </h1>
      <SecuritySettings data={data} />
    </>
  )
}
