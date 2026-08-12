import { runCronRoute } from "@/lib/scheduler/cron-route"
import { runMonitoringCron } from "@/lib/scheduler/runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return runCronRoute(request, {
    jobName: "monitor-check",
    run: runMonitoringCron,
  })
}
