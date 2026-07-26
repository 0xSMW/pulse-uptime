import type { DomainHealthCronResult } from "@/lib/domain-health/runtime"
import {
  type PorkbunWebhookPersistence,
  type PorkbunWebhookReceiverDependencies,
  receivePorkbunWebhook,
} from "./receiver"
import {
  type ClaimedPorkbunWebhookReceipt,
  claimPendingPorkbunWebhookReceipts,
  markPorkbunWebhookReceiptFailed,
  markPorkbunWebhookReceiptProcessed,
  notePorkbunWebhookReceived,
  PorkbunWebhookStore,
  readPorkbunWebhookSigningSecret,
} from "./store"

export const PORKBUN_WEBHOOK_RECEIPT_CLAIM_LIMIT = 50
export const PORKBUN_WEBHOOK_RECEIPT_STALE_MS = 10 * 60 * 1000

type PorkbunWebhookReceiver = (
  request: Request,
  dependencies: PorkbunWebhookReceiverDependencies
) => Promise<Response>

export interface PorkbunWebhookIngressDependencies {
  noteReceived: () => Promise<void>
  persistence: PorkbunWebhookPersistence
  readSigningSecret: () => Promise<string | null>
  receive: PorkbunWebhookReceiver
}

export interface PorkbunWebhookReceiptDependencies {
  claim: (input: {
    limit: number
    now: Date
    staleBefore: Date
  }) => Promise<ClaimedPorkbunWebhookReceipt[]>
  markFailed: (
    receipt: ClaimedPorkbunWebhookReceipt,
    errorCode: string
  ) => Promise<boolean>
  markProcessed: (receipt: ClaimedPorkbunWebhookReceipt) => Promise<boolean>
  now: () => Date
  runDomainHealthCron: (
    forcedApexDomains: ReadonlySet<string>
  ) => Promise<DomainHealthCronResult>
}

export interface PorkbunWebhookReceiptResult {
  claimedCount: number
  cron: DomainHealthCronResult
  forcedApexDomains: string[]
}

function runtimeIngressDependencies(): PorkbunWebhookIngressDependencies {
  return {
    noteReceived: notePorkbunWebhookReceived,
    persistence: new PorkbunWebhookStore(),
    readSigningSecret: readPorkbunWebhookSigningSecret,
    receive: receivePorkbunWebhook,
  }
}

function runtimeReceiptDependencies(): PorkbunWebhookReceiptDependencies {
  return {
    claim: claimPendingPorkbunWebhookReceipts,
    markFailed: markPorkbunWebhookReceiptFailed,
    markProcessed: markPorkbunWebhookReceiptProcessed,
    now: () => new Date(),
    runDomainHealthCron: async (forcedApexDomains) =>
      (await import("@/lib/domain-health/runtime")).runDomainHealthCron(
        forcedApexDomains
      ),
  }
}

function unavailableResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Webhook receiver unavailable" }),
    {
      status: 503,
      headers: { "cache-control": "no-store" },
    }
  )
}

/**
 * Verifies and records a delivery before acknowledgement. The integration
 * health timestamp is written only after the receiver accepted the delivery.
 */
export async function receivePorkbunWebhookRequest(
  request: Request,
  dependencies: PorkbunWebhookIngressDependencies = runtimeIngressDependencies()
): Promise<Response> {
  let signingSecret: string | null
  try {
    signingSecret = await dependencies.readSigningSecret()
  } catch {
    console.error("Porkbun webhook secret load failed", {
      errorCode: "webhook_secret_unavailable",
    })
    return unavailableResponse()
  }

  const response = await dependencies.receive(request, {
    persistence: dependencies.persistence,
    signingSecret: signingSecret ?? undefined,
  })
  if (response.status < 200 || response.status >= 300) {
    return response
  }

  try {
    await dependencies.noteReceived()
    return response
  } catch {
    // A retry becomes a durable duplicate and repairs this non-critical health
    // timestamp without ever returning the signing secret to the caller.
    console.error("Porkbun webhook health update failed", {
      errorCode: "webhook_health_update_failed",
    })
    return new Response(
      JSON.stringify({ error: "Webhook processing failed" }),
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      }
    )
  }
}

function receiptErrorCode(result: DomainHealthCronResult): string {
  switch (result.status) {
    case "completed":
      return "domain_cron_completed"
    case "duplicate":
      return "domain_cron_duplicate"
    case "failed":
      return "domain_cron_failed"
    case "lease-held":
      return "domain_cron_lease_held"
  }
}

async function releaseDomainReceipts(
  receipts: ClaimedPorkbunWebhookReceipt[],
  errorCode: string,
  dependencies: PorkbunWebhookReceiptDependencies
): Promise<void> {
  await Promise.all(
    receipts.map(async (receipt) => {
      try {
        await dependencies.markFailed(receipt, errorCode)
      } catch {
        console.error("Porkbun webhook receipt release failed", {
          errorCode: "webhook_receipt_release_failed",
        })
      }
    })
  )
}

/**
 * Converts durable verified deliveries into one bounded forced-domain run.
 * Receipts remain retryable unless that run completes successfully.
 */
export async function processPorkbunWebhookReceipts(
  dependencies: PorkbunWebhookReceiptDependencies = runtimeReceiptDependencies()
): Promise<PorkbunWebhookReceiptResult> {
  const now = dependencies.now()
  const receipts = await dependencies.claim({
    limit: PORKBUN_WEBHOOK_RECEIPT_CLAIM_LIMIT,
    now,
    staleBefore: new Date(now.getTime() - PORKBUN_WEBHOOK_RECEIPT_STALE_MS),
  })
  const testReceipts = receipts.filter(
    (receipt) => receipt.event === "webhook.test"
  )
  const domainReceipts = receipts.filter(
    (receipt) => receipt.event !== "webhook.test" && receipt.domain !== null
  )
  const forcedApexDomains = new Set(
    domainReceipts.map((receipt) => receipt.domain as string)
  )

  for (const receipt of testReceipts) {
    try {
      await dependencies.markProcessed(receipt)
    } catch {
      console.error("Porkbun test receipt processing failed", {
        errorCode: "webhook_test_receipt_processing_failed",
      })
    }
  }

  let cron: DomainHealthCronResult
  try {
    cron = await dependencies.runDomainHealthCron(forcedApexDomains)
  } catch (error) {
    await releaseDomainReceipts(
      domainReceipts,
      "domain_cron_exception",
      dependencies
    )
    throw new Error(
      "Domain health cron failed while processing Porkbun receipts",
      { cause: error }
    )
  }

  if (cron.status === "completed") {
    const persistedPorkbunApexes = new Set(cron.porkbunRefreshedApexDomains)
    for (const receipt of domainReceipts) {
      if (!persistedPorkbunApexes.has(receipt.domain as string)) {
        await releaseDomainReceipts(
          [receipt],
          "porkbun_refresh_not_confirmed",
          dependencies
        )
        continue
      }
      try {
        await dependencies.markProcessed(receipt)
      } catch {
        await releaseDomainReceipts(
          [receipt],
          "webhook_receipt_processing_failed",
          dependencies
        )
      }
    }
  } else {
    await releaseDomainReceipts(
      domainReceipts,
      receiptErrorCode(cron),
      dependencies
    )
  }

  return {
    claimedCount: receipts.length,
    cron,
    forcedApexDomains: [...forcedApexDomains].sort(),
  }
}
