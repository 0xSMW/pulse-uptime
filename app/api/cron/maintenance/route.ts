import { runMaintenanceCron } from "@/lib/maintenance/runtime"
import { runCronRoute } from "@/lib/scheduler/cron-route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return runCronRoute(request, {
    jobName: "maintenance",
    run: runMaintenanceCron,
  })
}
