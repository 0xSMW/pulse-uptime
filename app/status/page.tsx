import type { Metadata } from "next";

import { StatusPageContent } from "@/components/status-page/status-page-content";
import { StatusUnavailable } from "@/components/status-page/status-unavailable";
import { getPublicStatus, StatusDataUnavailableError } from "@/lib/reporting/queries/status";

export const metadata: Metadata = {
  title: "System Status",
  robots: { index: true, follow: true },
};

export const revalidate = 30;

export default async function PublicStatusPage() {
  let data;
  try {
    data = await getPublicStatus();
  } catch (error) {
    if (error instanceof StatusDataUnavailableError) return <StatusUnavailable />;
    throw error;
  }

  if (!data) return <StatusUnavailable />;

  return <StatusPageContent data={data} />;
}
