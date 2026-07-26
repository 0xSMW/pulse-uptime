import "server-only"

import { sql } from "drizzle-orm"

import { requireAcceptedConfig } from "@/lib/api/config-mutation"
import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  fetchPorkbunAccountDomains,
  type PorkbunDomainLookup,
} from "@/lib/domain-health/porkbun"
import {
  PorkbunWebhookClient,
  type PorkbunWebhookEndpoint,
  type PorkbunWebhookResult,
} from "@/lib/porkbun-webhooks/client"
import {
  type PorkbunIntegrationState,
  readPorkbunIntegration,
  upsertPorkbunIntegration,
} from "@/lib/porkbun-webhooks/store"
import { type DomainHealthMonitor, deriveDomainHealthTargets } from "./targets"

export type DomainMonitoringState =
  | "NOT_CONFIGURED"
  | "CONNECTED"
  | "NEEDS_ATTENTION"

export type DomainMonitoringWebhookStatus =
  | "NOT_CONFIGURED"
  | "ACTIVE"
  | "FAILING"

/** Safe, serializable installation state for the settings card and API. */
export interface DomainMonitoringData {
  state: DomainMonitoringState
  coveredDomainCount: number
  lastSuccessAt: string | null
  webhookStatus: DomainMonitoringWebhookStatus
  expiryAlertsEnabled: boolean
}

export class DomainMonitoringError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "PORKBUN_NOT_CONFIGURED"
      | "PORKBUN_UNAVAILABLE"
      | "WEBHOOK_NOT_CONFIGURED"
      | "WEBHOOK_URL_INVALID",
    message: string,
    cause?: unknown
  ) {
    super(message, { cause })
  }
}

export interface PorkbunSettingsDependencies {
  fetchAccountDomains: () => Promise<PorkbunDomainLookup>
  loadMonitors: () => Promise<readonly DomainHealthMonitor[]>
  now: () => Date
  readIntegration: (
    handle?: DatabaseHandle
  ) => Promise<PorkbunIntegrationState | null>
  webhookClient: Pick<
    PorkbunWebhookClient,
    | "createEndpoint"
    | "inspectDeliveryHealth"
    | "listEndpoints"
    | "testEndpoint"
    | "updateEndpoint"
  >
  upsertIntegration: (
    update: Parameters<typeof upsertPorkbunIntegration>[0],
    options?: Parameters<typeof upsertPorkbunIntegration>[1]
  ) => Promise<PorkbunIntegrationState>
  withWebhookProvisioningLock: <T>(
    work: (handle: DatabaseHandle) => Promise<T>
  ) => Promise<T>
}

export const PORKBUN_WEBHOOK_PROVISIONING_LOCK_KEY =
  "pulse:porkbun-webhook-provisioning"

/**
 * Serializes webhook endpoint adoption and creation. The provider request runs
 * inside the transaction deliberately: a later setup request must re-read the
 * integration only after the earlier request has persisted its endpoint id.
 */
export async function withPorkbunWebhookProvisioningLock<T>(
  work: (handle: DatabaseHandle) => Promise<T>,
  handle: DatabaseHandle = db
): Promise<T> {
  return await handle.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${PORKBUN_WEBHOOK_PROVISIONING_LOCK_KEY}))`
    )
    return await work(tx)
  })
}

function defaultDependencies(): PorkbunSettingsDependencies {
  return {
    fetchAccountDomains: fetchPorkbunAccountDomains,
    loadMonitors: async () => (await requireAcceptedConfig()).config.monitors,
    now: () => new Date(),
    readIntegration: readPorkbunIntegration,
    webhookClient: new PorkbunWebhookClient(),
    upsertIntegration: upsertPorkbunIntegration,
    withWebhookProvisioningLock: withPorkbunWebhookProvisioningLock,
  }
}

function dataFromIntegration(
  integration: PorkbunIntegrationState | null
): DomainMonitoringData {
  const providerError = integration?.providerLastErrorCode ?? null
  return {
    state: providerError
      ? providerError === "UNCONFIGURED"
        ? "NOT_CONFIGURED"
        : "NEEDS_ATTENTION"
      : integration?.providerLastSuccessAt
        ? "CONNECTED"
        : "NOT_CONFIGURED",
    coveredDomainCount: integration?.coveredDomainCount ?? 0,
    lastSuccessAt: integration?.providerLastSuccessAt?.toISOString() ?? null,
    webhookStatus:
      integration?.webhookStatus === "ACTIVE"
        ? "ACTIVE"
        : integration?.webhookStatus === "FAILING"
          ? "FAILING"
          : "NOT_CONFIGURED",
    expiryAlertsEnabled: integration?.expiryAlertsEnabled ?? false,
  }
}

function providerErrorCode(result: PorkbunDomainLookup): string | null {
  if (result.outcome === "resolved") {
    return null
  }
  return result.outcome === "failed"
    ? (result.reason ?? "FAILED").toUpperCase()
    : result.outcome.toUpperCase()
}

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!base) {
    throw new DomainMonitoringError(
      "WEBHOOK_URL_INVALID",
      "A public HTTPS application URL is required for Porkbun webhooks"
    )
  }
  if (!URL.canParse(base)) {
    throw new DomainMonitoringError(
      "WEBHOOK_URL_INVALID",
      "A public HTTPS application URL is required for Porkbun webhooks"
    )
  }
  const url = new URL("/api/webhooks/porkbun", base)
  if (url.protocol !== "https:") {
    throw new DomainMonitoringError(
      "WEBHOOK_URL_INVALID",
      "A public HTTPS application URL is required for Porkbun webhooks"
    )
  }
  return url.toString()
}

function providerFailure(result: PorkbunWebhookResult<unknown>): never {
  if (result.outcome === "unconfigured") {
    throw new DomainMonitoringError(
      "PORKBUN_NOT_CONFIGURED",
      "Porkbun credentials are not configured"
    )
  }
  throw new DomainMonitoringError(
    "PORKBUN_UNAVAILABLE",
    "Porkbun could not complete the request"
  )
}

function isExactCallback(
  endpoint: PorkbunWebhookEndpoint,
  url: string
): boolean {
  return endpoint.url === url
}

export async function getDomainMonitoringData(
  options: {
    handle?: DatabaseHandle
    dependencies?: Partial<PorkbunSettingsDependencies>
  } = {}
): Promise<DomainMonitoringData> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies }
  return dataFromIntegration(await dependencies.readIntegration(options.handle))
}

export async function updateDomainMonitoringSettings(
  input: { expiryAlertsEnabled: boolean },
  options: {
    handle?: DatabaseHandle
    dependencies?: Partial<PorkbunSettingsDependencies>
  } = {}
): Promise<DomainMonitoringData> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies }
  const integration = await dependencies.readIntegration(options.handle)
  if (
    input.expiryAlertsEnabled &&
    (!integration?.providerLastSuccessAt || integration.providerLastErrorCode)
  ) {
    throw new DomainMonitoringError(
      "PORKBUN_NOT_CONFIGURED",
      "Connect Porkbun before enabling expiry alerts"
    )
  }
  const saved = await dependencies.upsertIntegration(
    { expiryAlertsEnabled: input.expiryAlertsEnabled },
    options.handle ? { handle: options.handle } : undefined
  )
  return dataFromIntegration(saved)
}

/** Checks only the Porkbun account portfolio and persists display-safe health. */
export async function checkPorkbunConnection(
  options: { dependencies?: Partial<PorkbunSettingsDependencies> } = {}
): Promise<DomainMonitoringData> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies }
  const checkedAt = dependencies.now()
  const integration = await dependencies.readIntegration()
  const [result, monitors, webhookHealth] = await Promise.all([
    dependencies.fetchAccountDomains(),
    dependencies.loadMonitors(),
    integration?.webhookId
      ? dependencies.webhookClient.inspectDeliveryHealth(integration.webhookId)
      : Promise.resolve(null),
  ])
  const monitoredApexDomains = new Set(
    deriveDomainHealthTargets(monitors).apexDomains
  )
  const coveredDomainCount = result.domains.filter(
    (domain) =>
      domain.notLocal !== true &&
      monitoredApexDomains.has(domain.domain.toLowerCase())
  ).length
  const webhookUpdate =
    webhookHealth === null
      ? {}
      : webhookHealth.outcome === "ok"
        ? {
            webhookStatus:
              webhookHealth.data.endpoint.status === "DISABLED"
                ? ("DISABLED" as const)
                : (webhookHealth.data.endpoint.consecutiveFailures ?? 0) > 0 ||
                    webhookHealth.data.deliveries.some(
                      (delivery) => delivery.status === "FAILED"
                    )
                  ? ("FAILING" as const)
                  : ("ACTIVE" as const),
            webhookUrl: webhookHealth.data.endpoint.url,
          }
        : { webhookStatus: "FAILING" as const }
  const saved = await dependencies.upsertIntegration({
    coveredDomainCount,
    providerCheckedAt: checkedAt,
    providerLastErrorCode: providerErrorCode(result),
    providerLastSuccessAt:
      result.outcome === "resolved" ? checkedAt : undefined,
    ...webhookUpdate,
  })
  return dataFromIntegration(saved)
}

export async function managePorkbunWebhook(
  action: "enable" | "disable" | "test",
  options: { dependencies?: Partial<PorkbunSettingsDependencies> } = {}
): Promise<DomainMonitoringData> {
  const dependencies = { ...defaultDependencies(), ...options.dependencies }
  return await dependencies.withWebhookProvisioningLock(async (handle) => {
    const integration = await dependencies.readIntegration(handle)
    if (action === "test") {
      if (!integration?.webhookId) {
        throw new DomainMonitoringError(
          "WEBHOOK_NOT_CONFIGURED",
          "Enable the Porkbun webhook before testing it"
        )
      }
      const tested = await dependencies.webhookClient.testEndpoint(
        integration.webhookId
      )
      if (tested.outcome !== "ok") {
        return providerFailure(tested)
      }
      return dataFromIntegration(integration)
    }

    if (action === "disable") {
      if (!integration?.webhookId) {
        throw new DomainMonitoringError(
          "WEBHOOK_NOT_CONFIGURED",
          "Enable the Porkbun webhook before disabling it"
        )
      }
      const disabled = await dependencies.webhookClient.updateEndpoint({
        id: integration.webhookId,
        status: "DISABLED",
      })
      if (disabled.outcome !== "ok") {
        return providerFailure(disabled)
      }
      return dataFromIntegration(
        await dependencies.upsertIntegration(
          { webhookStatus: "DISABLED", webhookUrl: disabled.data.url },
          { handle }
        )
      )
    }

    const url = callbackUrl()
    let managedEndpoint: PorkbunWebhookResult<PorkbunWebhookEndpoint>
    if (integration?.webhookId) {
      managedEndpoint = await dependencies.webhookClient.updateEndpoint({
        id: integration.webhookId,
        status: "ACTIVE",
        url,
      })
      if (
        managedEndpoint.outcome !== "failed" ||
        managedEndpoint.httpStatus !== 404
      ) {
        if (managedEndpoint.outcome !== "ok") {
          return providerFailure(managedEndpoint)
        }
      } else {
        const listed = await dependencies.webhookClient.listEndpoints()
        if (listed.outcome !== "ok") {
          return providerFailure(listed)
        }
        const existing = listed.data.find((candidate) =>
          isExactCallback(candidate, url)
        )
        managedEndpoint = existing
          ? await dependencies.webhookClient.updateEndpoint({
              id: existing.id,
              status: "ACTIVE",
              url,
            })
          : await dependencies.webhookClient.createEndpoint(url)
      }
    } else {
      const listed = await dependencies.webhookClient.listEndpoints()
      if (listed.outcome !== "ok") {
        return providerFailure(listed)
      }
      const existing = listed.data.find((candidate) =>
        isExactCallback(candidate, url)
      )
      managedEndpoint = existing
        ? await dependencies.webhookClient.updateEndpoint({
            id: existing.id,
            status: "ACTIVE",
            url,
          })
        : await dependencies.webhookClient.createEndpoint(url)
    }
    if (managedEndpoint.outcome !== "ok") {
      return providerFailure(managedEndpoint)
    }
    return dataFromIntegration(
      await dependencies.upsertIntegration(
        {
          webhookId: managedEndpoint.data.id,
          webhookSecret: managedEndpoint.data.secret,
          webhookStatus: managedEndpoint.data.status,
          webhookUrl: managedEndpoint.data.url,
        },
        { handle }
      )
    )
  })
}
