import "server-only"

import { redirect } from "next/navigation"

import { authenticateCurrentSession } from "./session"

/**
 * Server gate for admin-only settings pages. Viewers land on the account page
 * instead of a workspace surface their scopes cannot operate.
 */
export async function requireAdminSettings() {
  const session = await authenticateCurrentSession()
  if (session?.role !== "admin") {
    redirect("/settings/account")
  }
  return session
}
