import { redirect } from "next/navigation"

import { AccountSettings } from "@/components/settings/account-settings"
import { getCurrentSession } from "@/lib/auth/session"
import { getAccountSettings } from "@/lib/reporting/queries/settings"

export default async function AccountSettingsPage() {
  const session = await getCurrentSession()
  if (!session) {
    redirect("/onboarding")
  }
  const data = await getAccountSettings(session.userId)
  if (!data) {
    redirect("/onboarding")
  }

  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Account</h1>
      <AccountSettings data={data} />
    </>
  )
}
