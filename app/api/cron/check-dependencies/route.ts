import { runDependencyCron } from "@/lib/dependencies/runtime"
import { runCronRoute } from "@/lib/scheduler/cron-route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return runCronRoute(request, {
    jobName: "check-dependencies",
    run: runDependencyCron,
  })
}
