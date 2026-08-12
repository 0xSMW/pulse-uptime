import type { DomainHealthCronResult } from "@/lib/domain-health/runtime"
import { processPorkbunWebhookReceipts } from "@/lib/porkbun-webhooks/runtime"
import { runCronRoute } from "@/lib/scheduler/cron-route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return runCronRoute(request, {
    jobName: "check-domains",
    async run(): Promise<DomainHealthCronResult> {
      try {
        return (await processPorkbunWebhookReceipts()).cron
      } catch {
        return {
          status: "failed",
          runId: "webhook-receipt-processing",
          error: "webhook_receipt_processing_failed",
        }
      }
    },
  })
}
