import { notFound } from "next/navigation";

import { MonitorDetail } from "@/components/monitors/monitor-detail";
import { getMonitorDetail } from "@/lib/reporting/queries/monitors";

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ monitorId: string }>;
}) {
  const { monitorId } = await params;
  const monitor = await getMonitorDetail(monitorId);

  if (!monitor) notFound();

  return <MonitorDetail monitor={monitor} />;
}
