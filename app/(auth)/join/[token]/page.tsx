import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { findPendingInvite } from "@/lib/auth/invites"
import { authenticateCurrentSession } from "@/lib/auth/session"

import styles from "../../auth.module.css"
import { JoinForm } from "./join-form"
import { SignOutButton } from "./sign-out-button"

/** The shared shell for the join page's dead-end states. */
function JoinNotice({
  title,
  lede,
  action,
}: {
  title: string
  lede: string
  action: React.ReactNode
}) {
  return (
    <div className={styles.flow}>
      <p className={styles.eyebrow}>Join Pulse</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lede}>{lede}</p>
      <Card className={styles.card}>{action}</Card>
    </div>
  )
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const invite = await findPendingInvite(token)
  if (!invite) {
    return (
      <JoinNotice
        action={
          <Link className={buttonVariants({ size: "md" })} href="/login">
            Back to sign in
          </Link>
        }
        lede="The link may have expired, been revoked, or already been used. Ask the person who invited you for a new link."
        title="This invite is no longer valid"
      />
    )
  }
  const session = await authenticateCurrentSession()
  if (session) {
    return (
      <JoinNotice
        action={<SignOutButton />}
        lede={`You are signed in as ${session.email}. This invite creates a new account, so sign out first to use it.`}
        title="You already have an account"
      />
    )
  }
  return <JoinForm role={invite.role} token={token} />
}
