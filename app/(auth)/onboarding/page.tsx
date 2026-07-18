import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { getCurrentSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { adminUsers, onboardingProgress } from "@/lib/db/schema";
import type { MonitorDraft, OnboardingStep } from "@/lib/onboarding/service";

import { OnboardingFlow } from "./onboarding-flow";

export default async function OnboardingPage() {
  let admins: { id: string }[] = [];
  try { admins = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1); } catch { /* readiness explains database failures */ }
  if (!admins.length) return <OnboardingFlow initialStep="readiness" />;

  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.onboardingCompletedAt) redirect("/");
  const [progress] = await db.select().from(onboardingProgress).where(eq(onboardingProgress.userId, session.userId)).limit(1);
  if (progress?.completedAt) redirect("/");
  return <OnboardingFlow
    initialStep={(progress?.currentStep as OnboardingStep) || "monitor"}
    initialDraft={(progress?.draftMonitor as MonitorDraft | null) ?? undefined}
    email={session.email}
    alertsDisabled={Boolean(progress?.emailWarningAcknowledged)}
  />;
}

