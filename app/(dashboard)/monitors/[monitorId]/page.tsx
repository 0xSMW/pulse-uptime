import { notFound } from "next/navigation"
import { Suspense } from "react"

import { MonitorDetail } from "@/components/monitors/monitor-detail"
import { MonitorDetailSkeleton } from "@/components/monitors/monitor-detail-skeleton"
import { listGroups } from "@/lib/api/groups"
import { hasScope, roleScopes } from "@/lib/api/scopes"
import { authenticateCurrentSession } from "@/lib/auth/session"
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
  const session = await authenticateCurrentSession()
  const canManageMonitors = hasScope(
    { scopes: roleScopes(session?.role ?? "viewer") },
    "monitors:write"
  )
  // One sub-ms lookup gates 404 and paints the real header; the seven-query
  // detail payload streams in behind it.
  const identity = await findMonitorIdentity(monitorId)
  if (!identity) {
    notFound()
  }

  return (
    <Suspense fallback={<MonitorDetailSkeleton identity={identity} />}>
      <MonitorDetailIsland
        canManageMonitors={canManageMonitors}
        monitorId={monitorId}
      />
    </Suspense>
  )
}

async function MonitorDetailIsland({
  canManageMonitors,
  monitorId,
}: {
  canManageMonitors: boolean
  monitorId: string
}) {
  const [monitor, groups] = await Promise.all([
    findMonitorDetail(monitorId),
    canManageMonitors ? listGroups() : Promise.resolve([]),
  ])
  if (!monitor) {
    notFound()
  }
  return (
    <MonitorDetail
      canManageMonitors={canManageMonitors}
      groups={groups}
      monitor={monitor}
    />
  )
}
