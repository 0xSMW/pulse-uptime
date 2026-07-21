import { redirect } from "next/navigation"

import { AccountSettings } from "@/components/settings/account-settings"
import { findAccountProfile } from "@/lib/api/account"
import { authenticateCurrentSession } from "@/lib/auth/session"

export default async function AccountSettingsPage() {
  const session = await authenticateCurrentSession()
  if (!session) {
    redirect("/onboarding")
  }
  const data = await findAccountProfile(session.userId)
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
