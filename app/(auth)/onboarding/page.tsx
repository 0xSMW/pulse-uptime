import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"

import { authenticateCurrentSession } from "@/lib/auth/session"
import { db } from "@/lib/db/client"
import { adminUsers, onboardingProgress } from "@/lib/db/schema"
import type { MonitorDraft, OnboardingStep } from "@/lib/onboarding/service"

import { OnboardingFlow } from "./onboarding-flow"

export default async function OnboardingPage() {
  let admins: { id: string }[] = []
  try {
    admins = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1)
  } catch {
    /* readiness explains database failures */
  }
  if (!admins.length) {
    return <OnboardingFlow initialStep="readiness" />
  }

  const session = await authenticateCurrentSession()
  if (!session) {
    redirect("/login")
  }
  if (session.onboardingCompletedAt) {
    redirect("/")
  }
  const [progress] = await db
    .select()
    .from(onboardingProgress)
    .where(eq(onboardingProgress.userId, session.userId))
    .limit(1)
  if (progress?.completedAt) {
    redirect("/")
  }
  return (
    <OnboardingFlow
      alertsDisabled={Boolean(progress?.emailWarningAcknowledged)}
      email={session.email}
      initialDraft={
        (progress?.draftMonitor as MonitorDraft | null) ?? undefined
      }
      initialStep={(progress?.currentStep as OnboardingStep) || "monitor"}
    />
  )
}
