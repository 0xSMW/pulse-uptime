import { notFound } from "next/navigation";
import { Suspense } from "react";

import { MonitorDetail } from "@/components/monitors/monitor-detail";
import { MonitorDetailSkeleton } from "@/components/monitors/monitor-detail-skeleton";
import { getMonitorDetail, getMonitorIdentity } from "@/lib/reporting/queries/monitors";

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ monitorId: string }>;
}) {
  const { monitorId } = await params;
  // The identity lookup gates 404 and renders the header. Five detail queries
  // stream in behind it.
  const identity = await getMonitorIdentity(monitorId);
  if (!identity) notFound();

  return (
    <Suspense fallback={<MonitorDetailSkeleton identity={identity} />}>
      <MonitorDetailIsland monitorId={monitorId} />
    </Suspense>
  );
}

async function MonitorDetailIsland({ monitorId }: { monitorId: string }) {
  const monitor = await getMonitorDetail(monitorId);
  if (!monitor) notFound();
  return <MonitorDetail monitor={monitor} />;
}
