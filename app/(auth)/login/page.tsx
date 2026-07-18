import { redirect } from "next/navigation";

import { db } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { getCurrentSession } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/return-to";

import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const value = (await searchParams).returnTo;
  const returnTo = safeReturnTo(Array.isArray(value) ? value[0] : value);
  const admins = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
  if (!admins.length) redirect("/onboarding");
  const session = await getCurrentSession();
  if (session) redirect(session.onboardingCompletedAt ? returnTo : "/onboarding");
  return <LoginForm returnTo={returnTo} />;
}
