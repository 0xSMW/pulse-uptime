import { runMaintenanceCron } from "@/lib/maintenance/runtime"
import { getPulseReleaseId } from "@/lib/release/id"
import {
  CRON_RESPONSE_HEADERS,
  isAuthorizedCronRequest,
} from "@/lib/scheduler/authentication"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: CRON_RESPONSE_HEADERS,
    })
  }
  const startedAt = Date.now()
  const releaseId = getPulseReleaseId()
  console.info(
    JSON.stringify({
      event: "cron.started",
      jobName: "maintenance",
      releaseId,
    })
  )
  const result = await runMaintenanceCron()
  const failed = result.status === "failed"
  console[failed ? "error" : "info"](
    JSON.stringify({
      event: failed ? "maintenance.failed" : "maintenance.completed",
      jobName: "maintenance",
      releaseId,
      status: result.status,
      ...(result.status === "failed" ? { errorCode: result.error } : {}),
      ...(result.status === "lease-held" ? {} : { runId: result.runId }),
      durationMs: Date.now() - startedAt,
    })
  )
  return new Response(JSON.stringify(result), {
    status: failed ? 500 : 200,
    headers: CRON_RESPONSE_HEADERS,
  })
}
