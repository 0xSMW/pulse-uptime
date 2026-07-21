import "server-only"

import { and, sql as drizzleSql, eq, isNull } from "drizzle-orm"

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
import { writeMonitoringEdgeConfig } from "@/lib/config/edge-config-write"
import { db } from "@/lib/db/client"
import {
  adminUsers,
  monitoringConfigSnapshots,
  monitorRegistry,
  monitorState,
  onboardingProgress,
} from "@/lib/db/schema"

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
      | "ACTIVATION_FAILED",
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

async function getOnboardingState(userId: string) {
  const [row] = await db
    .select()
    .from(onboardingProgress)
    .where(eq(onboardingProgress.userId, userId))
    .limit(1)
  return row ?? null
}

export async function saveMonitorDraft(userId: string, input: MonitorDraft) {
  const draft = validateDraft(input)
  await db
    .update(onboardingProgress)
    .set({ draftMonitor: draft, currentStep: "verify", updatedAt: new Date() })
    .where(
      and(
        eq(onboardingProgress.userId, userId),
        isNull(onboardingProgress.completedAt)
      )
    )
  return draft
}

export async function moveBack(userId: string, step: "monitor" | "verify") {
  await db
    .update(onboardingProgress)
    .set({ currentStep: step, updatedAt: new Date() })
    .where(
      and(
        eq(onboardingProgress.userId, userId),
        isNull(onboardingProgress.completedAt)
      )
    )
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

export async function activateFirstMonitor(
  userId: string,
  input: { alertEmail?: string; startAnyway?: boolean }
) {
  const readiness = await checkOnboardingReadiness()
  if (!readiness.canContinue) {
    throw new OnboardingError("NOT_READY", "Required services are unavailable")
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext('pulse:initial-monitor'))`
    )
    const [state] = await tx
      .select()
      .from(onboardingProgress)
      .where(
        and(
          eq(onboardingProgress.userId, userId),
          isNull(onboardingProgress.completedAt)
        )
      )
      .limit(1)
    if (!state?.draftMonitor) {
      throw new OnboardingError("INVALID_DRAFT", "Add your website first")
    }
    const draft = validateDraft(state.draftMonitor as MonitorDraft)
    const check = await runManualCheck(draft.url)
    if (isSecurityFailure(check)) {
      throw new OnboardingError(
        "CHECK_BLOCKED",
        "This address cannot be monitored safely"
      )
    }
    if (!(check.success || input.startAnyway)) {
      throw new OnboardingError("CHECK_FAILED", "Website check failed")
    }

    const recipients = state.emailWarningAcknowledged
      ? []
      : validateRecipients(input.alertEmail)
    const monitor = createMonitorWithDefaults({
      id: monitorIdFor(draft.name, draft.url),
      name: draft.name,
      url: draft.url,
    })
    const configuredMonitor: MonitorConfig = { ...monitor, recipients }
    const config = validateMonitoringConfig({
      schemaVersion: 2,
      configVersion: 1,
      settings: { ...DEFAULT_MONITOR_SETTINGS, defaultRecipients: recipients },
      groups: [],
      monitors: [configuredMonitor],
    }) as MonitoringConfig
    const hash = hashMonitoringConfig(config)

    const existing = await tx
      .select({ hash: monitoringConfigSnapshots.configHash })
      .from(monitoringConfigSnapshots)
      .where(eq(monitoringConfigSnapshots.configHash, hash))
      .limit(1)
    await writeEdgeConfig(config)
    const now = new Date()
    if (existing.length === 0) {
      await tx.insert(monitoringConfigSnapshots).values({
        id: crypto.randomUUID(),
        configVersion: config.configVersion,
        configHash: hash,
        configJson: config,
        status: "accepted",
        source: "onboarding",
        seenAt: now,
        acceptedAt: now,
      })
    }
    await tx
      .insert(monitorRegistry)
      .values({
        id: configuredMonitor.id,
        name: configuredMonitor.name,
        url: configuredMonitor.url,
        groupName: null,
        enabled: true,
        configHash: hash,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: monitorRegistry.id,
        set: {
          name: configuredMonitor.name,
          url: configuredMonitor.url,
          enabled: true,
          configHash: hash,
          lastSeenAt: now,
          archivedAt: null,
        },
      })
    await tx
      .insert(monitorState)
      .values({
        monitorId: configuredMonitor.id,
        state: "PENDING",
        updatedAt: now,
      })
      .onConflictDoNothing()
    await tx
      .update(onboardingProgress)
      .set({ currentStep: "getting_started", updatedAt: new Date() })
      .where(eq(onboardingProgress.userId, userId))
    return { monitor: configuredMonitor, check }
  })
}

export async function completeOnboarding(userId: string) {
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(onboardingProgress)
      .set({ completedAt: now, updatedAt: now })
      .where(
        and(
          eq(onboardingProgress.userId, userId),
          isNull(onboardingProgress.completedAt)
        )
      )
    await tx
      .update(adminUsers)
      .set({ onboardingCompletedAt: now, updatedAt: now })
      .where(eq(adminUsers.id, userId))
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
