import { isProductionRuntime, resolveReleaseIdFromEnv } from "@/lib/release/id"
import {
  CRON_RESPONSE_HEADERS,
  isAuthorizedCronRequest,
} from "@/lib/scheduler/authentication"
import {
  createSqlDeployProofStore,
  evaluateDeployProof,
  parsePromotionBoundary,
  serializeDeployProof,
} from "@/lib/scheduler/deploy-proof"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: CRON_RESPONSE_HEADERS,
    })
  }

  const release = resolveReleaseIdFromEnv()
  if (!release.ok) {
    // Production without a valid release identity cannot prove a deploy.
    // Non-production misconfiguration also fails closed on this endpoint so
    // the canary never treats an unidentifiable host as ready.
    const body = {
      status: "misconfigured",
      error: `PULSE_RELEASE_ID is ${release.reason}`,
      production: isProductionRuntime(),
    }
    console.error(
      JSON.stringify({
        event: "deploy_proof.misconfigured",
        reason: release.reason,
        production: body.production,
      })
    )
    return new Response(JSON.stringify(body), {
      status: 500,
      headers: CRON_RESPONSE_HEADERS,
    })
  }

  const url = new URL(request.url)
  const after = parsePromotionBoundary(url.searchParams.get("after"))
  if (!after) {
    return new Response(
      JSON.stringify({
        status: "invalid_request",
        error: "Query parameter after must be a valid ISO-8601 timestamp",
      }),
      {
        status: 400,
        headers: CRON_RESPONSE_HEADERS,
      }
    )
  }

  const result = await evaluateDeployProof({
    releaseId: release.releaseId,
    after,
    store: createSqlDeployProofStore(),
  })

  console.info(
    JSON.stringify({
      event:
        result.status === "ready"
          ? "deploy_proof.ready"
          : "deploy_proof.waiting",
      releaseId: release.releaseId,
      after: after.toISOString(),
      ...(result.status === "ready"
        ? { runId: result.runId, completedAt: result.completedAt.toISOString() }
        : { latestStatus: result.latest?.status ?? null }),
    })
  )

  return new Response(JSON.stringify(serializeDeployProof(result)), {
    status: result.status === "ready" ? 200 : 202,
    headers: CRON_RESPONSE_HEADERS,
  })
}
