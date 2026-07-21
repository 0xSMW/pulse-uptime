import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq, inArray, isNull } from "drizzle-orm"

import { lockConfiguration } from "@/lib/api/configuration-lock"
import {
  type CheckResult,
  parsePublicHttpUrl,
  runManualCheck,
} from "@/lib/checker"
import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
  hashMonitoringConfig,
  type MonitorConfig,
  type MonitoringConfig,
  validateMonitoringConfig,
} from "@/lib/config"
import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import { writeMonitoringEdgeConfig } from "@/lib/config/edge-config-write"
import {
  type DatabaseHandle,
  type DatabaseTransaction,
  db,
} from "@/lib/db/client"
import {
  adminUsers,
  monitoringConfigSnapshots,
  monitorRegistry,
  onboardingProgress,
} from "@/lib/db/schema"
import { synchronizeRegistry } from "@/lib/scheduler/registry-sync"

import { checkOnboardingReadiness } from "./readiness"

export type OnboardingStep = "monitor" | "verify" | "getting_started"
export interface MonitorDraft {
  url: string
  name: string
  alertEmail?: string
}

export class OnboardingError extends Error {
  constructor(
    readonly code:
      | "INVALID_DRAFT"
      | "NOT_READY"
      | "CHECK_BLOCKED"
      | "CHECK_FAILED"
      | "ACTIVATION_FAILED"
      | "ONBOARDING_STATE_CONFLICT",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "OnboardingError"
  }
}

export function deriveMonitorName(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

export function monitorIdFor(name: string, url: string): string {
  const source = name.trim() || deriveMonitorName(url)
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return (slug || "first-monitor").slice(0, 64).replace(/-$/, "").padEnd(3, "0")
}

export function validateDraft(input: MonitorDraft): MonitorDraft {
  let parsed: URL
  try {
    parsed = parsePublicHttpUrl(input.url.trim())
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new OnboardingError(
      "INVALID_DRAFT",
      "Enter a public HTTP or HTTPS URL",
      { cause: error }
    )
  }
  const name = input.name.trim()
  if (!name || name.length > 80) {
    throw new OnboardingError(
      "INVALID_DRAFT",
      "Use a monitor name under 80 characters"
    )
  }
  return {
    url: parsed.href,
    name,
    alertEmail: input.alertEmail?.trim().toLowerCase(),
  }
}

type ProgressRow = typeof onboardingProgress.$inferSelect

export interface OnboardingMonitorStore {
  updateDraft: (
    userId: string,
    draft: MonitorDraft
  ) => Promise<"ok" | "conflict">
  moveBack: (
    userId: string,
    step: "monitor" | "verify"
  ) => Promise<"ok" | "conflict">
  readProgress: (userId: string) => Promise<ProgressRow | null>
  transaction: <T>(work: (tx: OnboardingMonitorTx) => Promise<T>) => Promise<T>
}

export interface OnboardingMonitorTx {
  lockConfiguration: () => Promise<void>
  readProgress: (userId: string) => Promise<ProgressRow | null>
  readAccepted: () => Promise<{
    config: MonitoringConfig
    hash: string
  } | null>
  insertAcceptedSnapshot: (input: {
    config: MonitoringConfig
    hash: string
    now: Date
  }) => Promise<void>
  synchronizeRegistry: (
    config: MonitoringConfig,
    hash: string,
    now: Date
  ) => Promise<void>
  advanceToGettingStarted: (userId: string) => Promise<boolean>
  countEnabledRegistryForHash: (hash: string) => Promise<number>
  completeProgress: (userId: string, now: Date) => Promise<boolean>
  completeAdmin: (userId: string, now: Date) => Promise<boolean>
}

export interface ActivateFirstMonitorDeps {
  store?: OnboardingMonitorStore
  checkReadiness?: () => Promise<{ canContinue: boolean }>
  runCheck?: (url: string) => Promise<CheckResult>
  writeEdgeConfig?: (config: MonitoringConfig) => Promise<void>
}

export interface CompleteOnboardingDeps {
  store?: OnboardingMonitorStore
}

export interface SaveMonitorDraftDeps {
  store?: OnboardingMonitorStore
}

function createDatabaseStore(
  handle: DatabaseHandle = db
): OnboardingMonitorStore {
  const asDb = (executor: DatabaseHandle) => executor as unknown as typeof db

  const readProgressVia = async (
    executor: DatabaseHandle,
    userId: string
  ): Promise<ProgressRow | null> => {
    const [row] = await executor
      .select()
      .from(onboardingProgress)
      .where(eq(onboardingProgress.userId, userId))
      .limit(1)
    return row ?? null
  }

  return {
    updateDraft: async (userId, draft) => {
      const updated = await handle
        .update(onboardingProgress)
        .set({
          draftMonitor: draft,
          currentStep: "verify",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(onboardingProgress.userId, userId),
            isNull(onboardingProgress.completedAt),
            inArray(onboardingProgress.currentStep, ["monitor", "verify"])
          )
        )
        .returning({ userId: onboardingProgress.userId })
      return updated.length > 0 ? "ok" : "conflict"
    },
    moveBack: async (userId, step) => {
      // Back only within pre-activation steps so activation cannot be undone
      // by a stale navigation after getting_started.
      const updated = await handle
        .update(onboardingProgress)
        .set({ currentStep: step, updatedAt: new Date() })
        .where(
          and(
            eq(onboardingProgress.userId, userId),
            isNull(onboardingProgress.completedAt),
            inArray(onboardingProgress.currentStep, ["monitor", "verify"])
          )
        )
        .returning({ userId: onboardingProgress.userId })
      return updated.length > 0 ? "ok" : "conflict"
    },
    readProgress: (userId) => readProgressVia(handle, userId),
    transaction: async (work) =>
      await handle.transaction(async (tx) => {
        const dbTx = tx as DatabaseTransaction
        return await work({
          lockConfiguration: async () => {
            await lockConfiguration(dbTx)
          },
          readProgress: (userId) => readProgressVia(dbTx, userId),
          readAccepted: async () => {
            const snapshot = await findAcceptedSnapshot(asDb(dbTx))
            return snapshot
              ? { config: snapshot.config, hash: snapshot.hash }
              : null
          },
          insertAcceptedSnapshot: async ({ config, hash, now }) => {
            await dbTx.insert(monitoringConfigSnapshots).values({
              id: randomUUID(),
              configVersion: config.configVersion,
              configHash: hash,
              configJson: config,
              status: "accepted",
              source: "onboarding",
              seenAt: now,
              acceptedAt: now,
            })
          },
          synchronizeRegistry: async (config, hash, now) => {
            await synchronizeRegistry(dbTx, config, hash, now, "api")
          },
          advanceToGettingStarted: async (userId) => {
            const updated = await dbTx
              .update(onboardingProgress)
              .set({ currentStep: "getting_started", updatedAt: new Date() })
              .where(
                and(
                  eq(onboardingProgress.userId, userId),
                  eq(onboardingProgress.currentStep, "verify"),
                  isNull(onboardingProgress.completedAt)
                )
              )
              .returning({ userId: onboardingProgress.userId })
            return updated.length > 0
          },
          countEnabledRegistryForHash: async (hash) => {
            const rows = await dbTx
              .select({ id: monitorRegistry.id })
              .from(monitorRegistry)
              .where(
                and(
                  eq(monitorRegistry.enabled, true),
                  eq(monitorRegistry.configHash, hash),
                  isNull(monitorRegistry.archivedAt)
                )
              )
              .limit(1)
            return rows.length
          },
          completeProgress: async (userId, now) => {
            const updated = await dbTx
              .update(onboardingProgress)
              .set({ completedAt: now, updatedAt: now })
              .where(
                and(
                  eq(onboardingProgress.userId, userId),
                  eq(onboardingProgress.currentStep, "getting_started"),
                  isNull(onboardingProgress.completedAt)
                )
              )
              .returning({ userId: onboardingProgress.userId })
            return updated.length > 0
          },
          completeAdmin: async (userId, now) => {
            const updated = await dbTx
              .update(adminUsers)
              .set({ onboardingCompletedAt: now, updatedAt: now })
              .where(
                and(
                  eq(adminUsers.id, userId),
                  isNull(adminUsers.onboardingCompletedAt)
                )
              )
              .returning({ id: adminUsers.id })
            return updated.length > 0
          },
        })
      }),
  }
}

const defaultStore = createDatabaseStore()

async function getOnboardingState(userId: string, store = defaultStore) {
  return store.readProgress(userId)
}

export async function saveMonitorDraft(
  userId: string,
  input: MonitorDraft,
  deps: SaveMonitorDraftDeps = {}
) {
  const store = deps.store ?? defaultStore
  const draft = validateDraft(input)
  const result = await store.updateDraft(userId, draft)
  if (result === "conflict") {
    throw new OnboardingError(
      "ONBOARDING_STATE_CONFLICT",
      "Onboarding is not ready for a monitor draft"
    )
  }
  return draft
}

export async function moveBack(userId: string, step: "monitor" | "verify") {
  const result = await defaultStore.moveBack(userId, step)
  if (result === "conflict") {
    throw new OnboardingError(
      "ONBOARDING_STATE_CONFLICT",
      "Onboarding cannot move to that step"
    )
  }
}

export async function verifyDraft(userId: string) {
  const state = await getOnboardingState(userId)
  if (!state?.draftMonitor) {
    throw new OnboardingError("INVALID_DRAFT", "Add your website first")
  }
  const draft = validateDraft(state.draftMonitor as MonitorDraft)
  const result = await runManualCheck(draft.url)
  return {
    result,
    canStartAnyway: !(result.success || isSecurityFailure(result)),
  }
}

export function isSecurityFailure(result: CheckResult) {
  return (
    !result.success &&
    ["INVALID_URL", "BLOCKED_TARGET", "DNS_ERROR", "INVALID_REDIRECT"].includes(
      result.errorCode
    )
  )
}

function buildActivationConfig(input: {
  draft: MonitorDraft
  recipients: string[]
  accepted: { config: MonitoringConfig; hash: string } | null
}): { config: MonitoringConfig; monitor: MonitorConfig; hash: string } {
  const monitor = createMonitorWithDefaults({
    id: monitorIdFor(input.draft.name, input.draft.url),
    name: input.draft.name,
    url: input.draft.url,
  })
  const configuredMonitor: MonitorConfig = {
    ...monitor,
    recipients: input.recipients,
  }

  if (input.accepted) {
    const others = input.accepted.config.monitors.filter(
      (item) => item.id !== configuredMonitor.id
    )
    const config = validateMonitoringConfig({
      schemaVersion: 2,
      configVersion: input.accepted.config.configVersion + 1,
      settings: {
        ...input.accepted.config.settings,
        defaultRecipients: input.recipients,
      },
      groups: input.accepted.config.groups,
      monitors: [...others, configuredMonitor],
    }) as MonitoringConfig
    return {
      config,
      monitor: configuredMonitor,
      hash: hashMonitoringConfig(config),
    }
  }

  const config = validateMonitoringConfig({
    schemaVersion: 2,
    configVersion: 1,
    settings: {
      ...DEFAULT_MONITOR_SETTINGS,
      defaultRecipients: input.recipients,
    },
    groups: [],
    monitors: [configuredMonitor],
  }) as MonitoringConfig
  return {
    config,
    monitor: configuredMonitor,
    hash: hashMonitoringConfig(config),
  }
}

export async function activateFirstMonitor(
  userId: string,
  input: { alertEmail?: string; startAnyway?: boolean },
  deps: ActivateFirstMonitorDeps = {}
) {
  const store = deps.store ?? defaultStore
  const checkReadiness = deps.checkReadiness ?? checkOnboardingReadiness
  const runCheck = deps.runCheck ?? runManualCheck
  const writeEdge =
    deps.writeEdgeConfig ??
    (async (config: MonitoringConfig) => {
      await writeEdgeConfig(config)
    })

  const readiness = await checkReadiness()
  if (!readiness.canContinue) {
    throw new OnboardingError("NOT_READY", "Required services are unavailable")
  }

  // Site check runs outside the configuration lock so activation network time
  // does not block concurrent config writers.
  const preState = await store.readProgress(userId)
  if (
    !preState ||
    preState.completedAt ||
    preState.currentStep !== "verify" ||
    !preState.draftMonitor
  ) {
    throw new OnboardingError(
      "ONBOARDING_STATE_CONFLICT",
      "Onboarding is not ready to start monitoring"
    )
  }
  const draft = validateDraft(preState.draftMonitor as MonitorDraft)
  const check = await runCheck(draft.url)
  if (isSecurityFailure(check)) {
    throw new OnboardingError(
      "CHECK_BLOCKED",
      "This address cannot be monitored safely"
    )
  }
  if (!(check.success || input.startAnyway)) {
    throw new OnboardingError("CHECK_FAILED", "Website check failed")
  }
  const recipients = preState.emailWarningAcknowledged
    ? []
    : validateRecipients(input.alertEmail)

  const activated = await store.transaction(async (tx) => {
    await tx.lockConfiguration()
    const state = await tx.readProgress(userId)
    if (
      !state ||
      state.completedAt ||
      state.currentStep !== "verify" ||
      !state.draftMonitor
    ) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Onboarding is not ready to start monitoring"
      )
    }

    const lockedDraft = validateDraft(state.draftMonitor as MonitorDraft)
    // Draft URL must still match the check we already ran.
    if (lockedDraft.url !== draft.url || lockedDraft.name !== draft.name) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Onboarding is not ready to start monitoring"
      )
    }

    const lockedRecipients = state.emailWarningAcknowledged
      ? []
      : recipients
    const accepted = await tx.readAccepted()
    const { config, monitor, hash } = buildActivationConfig({
      draft: lockedDraft,
      recipients: lockedRecipients,
      accepted,
    })
    const now = new Date()
    const wroteSnapshot = !accepted || accepted.hash !== hash

    // Snapshot, registry, and step transition commit together under the lock.
    if (wroteSnapshot) {
      await tx.insertAcceptedSnapshot({ config, hash, now })
    }
    await tx.synchronizeRegistry(config, hash, now)

    const advanced = await tx.advanceToGettingStarted(userId)
    if (!advanced) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Onboarding is not ready to start monitoring"
      )
    }

    return { monitor, config, hash, wroteSnapshot }
  })

  // Edge Config is external and not rollbackable. Write after the DB commit so
  // the configuration lock is not held across HTTP.
  if (activated.wroteSnapshot) {
    await writeEdge(activated.config)
  }

  return {
    monitor: activated.monitor,
    check,
    config: activated.config,
    hash: activated.hash,
  }
}

export async function completeOnboarding(
  userId: string,
  deps: CompleteOnboardingDeps = {}
) {
  const store = deps.store ?? defaultStore
  const now = new Date()

  await store.transaction(async (tx) => {
    await tx.lockConfiguration()
    const state = await tx.readProgress(userId)
    if (
      !state ||
      state.completedAt ||
      state.currentStep !== "getting_started"
    ) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Finish setup before opening the dashboard"
      )
    }

    const accepted = await tx.readAccepted()
    if (!accepted) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Start monitoring before opening the dashboard"
      )
    }

    const enabledCount = await tx.countEnabledRegistryForHash(accepted.hash)
    if (enabledCount < 1) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Start monitoring before opening the dashboard"
      )
    }

    const progressOk = await tx.completeProgress(userId, now)
    const adminOk = await tx.completeAdmin(userId, now)
    if (!(progressOk && adminOk)) {
      throw new OnboardingError(
        "ONBOARDING_STATE_CONFLICT",
        "Finish setup before opening the dashboard"
      )
    }
  })
}

function validateRecipients(email?: string) {
  if (!email) {
    return []
  }
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new OnboardingError("INVALID_DRAFT", "Enter a valid alert email")
  }
  return [normalized]
}

async function writeEdgeConfig(config: MonitoringConfig) {
  try {
    await writeMonitoringEdgeConfig(config)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new OnboardingError(
      "ACTIVATION_FAILED",
      "Could not start monitoring. Try again",
      { cause: error }
    )
  }
}
