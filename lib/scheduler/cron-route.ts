import { getPulseReleaseId } from "@/lib/release/id"

import {
  CRON_RESPONSE_HEADERS,
  isAuthorizedCronRequest,
} from "./authentication"

interface StandardCronResult {
  error?: string
  runId?: string
  status: string
}

interface StandardCronRouteOptions<Result extends StandardCronResult> {
  jobName: string
  run: () => Promise<Result>
}

export async function runCronRoute<Result extends StandardCronResult>(
  request: Request,
  options: StandardCronRouteOptions<Result>
): Promise<Response> {
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
      jobName: options.jobName,
      releaseId,
    })
  )

  const result = await options.run()
  const failed = result.status === "failed"
  console[failed ? "error" : "info"](
    JSON.stringify({
      event: failed ? "cron.failed" : "cron.completed",
      jobName: options.jobName,
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
