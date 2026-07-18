import { notFound } from "next/navigation";

import { StatusPageContent } from "@/components/status-page/status-page-content";
import { StatusUnavailable } from "@/components/status-page/status-unavailable";
import { getPublicStatus, StatusDataUnavailableError } from "@/lib/reporting/queries/status";

export const revalidate = 30;

export const metadata = {
  title: "Group Status",
  robots: { index: true, follow: true },
};

type GroupPageProps = {
  params: Promise<{ group: string }>;
};

export default async function PublicGroupStatusPage({ params }: GroupPageProps) {
  const { group } = await params;

  let data;
  try {
    data = await getPublicStatus(group);
  } catch (error) {
    if (error instanceof StatusDataUnavailableError) return <StatusUnavailable />;
    throw error;
  }

  if (!data) notFound();

  return <StatusPageContent data={data} groupView />;
}
