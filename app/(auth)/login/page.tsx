import { redirect } from "next/navigation";

import { db } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { getCurrentSession } from "@/lib/auth/session";

import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const admins = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
  if (!admins.length) redirect("/onboarding");
  const session = await getCurrentSession();
  if (session) redirect(session.onboardingCompletedAt ? "/" : "/onboarding");
  return <LoginForm />;
}

