import { redirect } from "next/navigation";

import { TopNav } from "@/components/dashboard/top-nav";
import { getCurrentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/onboarding");
  if (!session.onboardingCompletedAt) redirect("/onboarding");

  return (
    <div className="min-h-screen">
      <TopNav email={session.email} />
      <main className="mx-auto max-w-[1200px] px-6 py-8 lg:px-8">{children}</main>
    </div>
  );
}
