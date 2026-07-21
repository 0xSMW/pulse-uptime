import Link from "next/link"
import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { lookupAuthorization } from "./actions"
import { AuthorizationFlow } from "./authorization-flow"
import styles from "./authorize.module.css"

export default async function CliAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string | string[] }>
}) {
  const params = await searchParams
  const initialCode =
    typeof params.user_code === "string" ? params.user_code : ""
  const session = await getCurrentSession()
  if (!session) {
    const destination = initialCode
      ? `/cli/authorize?user_code=${encodeURIComponent(initialCode)}`
      : "/cli/authorize"
    redirect(`/login?returnTo=${encodeURIComponent(destination)}`)
  }

  const initialResult = initialCode
    ? await lookupAuthorization(initialCode)
    : null
  const initialRequest =
    initialResult?.ok && "request" in initialResult
      ? initialResult.request
      : undefined
  const initialError =
    initialResult && !initialResult.ok ? initialResult.message : undefined

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link aria-label="Pulse dashboard" className={styles.wordmark} href="/">
          <span aria-hidden="true" className={styles.brandDot} />
          Pulse
        </Link>
      </header>
      <AuthorizationFlow
        accountEmail={session.email}
        initialCode={initialCode}
        initialError={initialError}
        initialRequest={initialRequest}
      />
    </main>
  )
}
