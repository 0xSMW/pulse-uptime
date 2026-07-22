import Link from "next/link"

import { Card } from "@/components/ui/card"
import { findPendingInvite } from "@/lib/auth/invites"
import { authenticateCurrentSession } from "@/lib/auth/session"

import styles from "../../auth.module.css"
import { JoinForm } from "./join-form"

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const invite = await findPendingInvite(token)
  if (!invite) {
    return (
      <div className={styles.flow}>
        <p className={styles.eyebrow}>Join Pulse</p>
        <h1 className={styles.title}>This invite is no longer valid</h1>
        <p className={styles.lede}>
          The link may have expired, been revoked, or already been used. Ask the
          person who invited you for a new link.
        </p>
      </div>
    )
  }
  const session = await authenticateCurrentSession()
  if (session) {
    return (
      <div className={styles.flow}>
        <p className={styles.eyebrow}>Join Pulse</p>
        <h1 className={styles.title}>You already have an account</h1>
        <p className={styles.lede}>
          You are signed in as {session.email}. This invite creates a new
          account, so sign out first to use it.
        </p>
        <Card className={styles.card}>
          <Link className="text-[13px] underline underline-offset-4" href="/">
            Back to the dashboard
          </Link>
        </Card>
      </div>
    )
  }
  return <JoinForm role={invite.role} token={token} />
}
