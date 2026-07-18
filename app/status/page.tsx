import type { Metadata } from "next";

import { StatusPageContent } from "@/components/status-page/status-page-content";
import { getPublicStatus } from "@/lib/reporting/queries/status";

export const metadata: Metadata = {
  title: "System Status",
  robots: { index: true, follow: true },
};

export const revalidate = 30;

export default async function PublicStatusPage() {
  const data = await getPublicStatus();

  if (!data) {
    return (
      <main className="mx-auto w-full max-w-[720px] px-4 py-12 sm:px-6">
        <h1 className="text-base font-semibold">System Status</h1>
        <div className="mt-6 rounded-xl border border-[var(--border-strong)] p-6">
          <h2 className="text-sm font-semibold">Status unavailable</h2>
          <p className="mt-2 text-[13px] text-[var(--fg-muted)]">Please check again shortly</p>
        </div>
      </main>
    );
  }

  return <StatusPageContent data={data} />;
}
