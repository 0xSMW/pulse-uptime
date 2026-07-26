import {
  type PorkbunWebhookReceiverDependencies,
  receivePorkbunWebhook,
} from "@/lib/porkbun-webhooks/receiver"
import { receivePorkbunWebhookRequest } from "@/lib/porkbun-webhooks/runtime"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function createPorkbunWebhookPost(
  dependencies: PorkbunWebhookReceiverDependencies
): (request: Request) => Promise<Response> {
  return (request) => receivePorkbunWebhook(request, dependencies)
}

export async function POST(request: Request): Promise<Response> {
  return receivePorkbunWebhookRequest(request)
}
