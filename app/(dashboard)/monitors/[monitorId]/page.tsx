import { notFound } from "next/navigation"
import { Suspense } from "react"

import { MonitorDetail } from "@/components/monitors/monitor-detail"
import { MonitorDetailSkeleton } from "@/components/monitors/monitor-detail-skeleton"
import { listGroups } from "@/lib/api/groups"
import {
  findMonitorDetail,
  findMonitorIdentity,
} from "@/lib/reporting/queries/monitors"

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ monitorId: string }>
}) {
  const { monitorId } = await params
  // One sub-ms lookup gates 404 and paints the real header; the seven-query
  // detail payload streams in behind it.
  const identity = await findMonitorIdentity(monitorId)
  if (!identity) {
    notFound()
  }

  return (
    <Suspense fallback={<MonitorDetailSkeleton identity={identity} />}>
      <MonitorDetailIsland monitorId={monitorId} />
    </Suspense>
  )
}

async function MonitorDetailIsland({ monitorId }: { monitorId: string }) {
  const [monitor, groups] = await Promise.all([
    findMonitorDetail(monitorId),
    listGroups(),
  ])
  if (!monitor) {
    notFound()
  }
  return <MonitorDetail groups={groups} monitor={monitor} />
}
