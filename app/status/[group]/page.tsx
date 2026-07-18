import { notFound } from "next/navigation";

import { StatusPageContent } from "@/components/status-page/status-page-content";
import { getPublicStatus } from "@/lib/reporting/queries/status";

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
  const data = await getPublicStatus(group);

  if (!data) notFound();

  return <StatusPageContent data={data} groupView />;
}
