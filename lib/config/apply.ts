import {
  type ConfigurationPlan,
  createConfigurationPlan,
  type PlanOptions,
} from "./plan"
import type { DeclarativeConfig } from "./schema"

export type ConfigApplyErrorCode =
  | "PRECONDITION_MISMATCH"
  | "CONFIG_VERSION_CONFLICT"
  | "TARGET_CONFIG_HASH_MISMATCH"
  | "PLAN_HASH_MISMATCH"
  | "DESTRUCTIVE_CONSENT_REQUIRED"

export class ConfigApplyError extends Error {
  constructor(
    readonly code: ConfigApplyErrorCode,
    message: string
  ) {
    super(message)
    this.name = "ConfigApplyError"
  }
}

export interface ConfigurationApplyRequest {
  baseConfigHash: string
  targetConfigHash: string
  planHash: string
  targetConfig: unknown
  allowDestructiveChanges?: boolean
}

export interface ApplyPreconditionInput {
  ifMatch: string | null | undefined
  request: ConfigurationApplyRequest
  currentConfig: DeclarativeConfig
  currentConfigHash: string
  archivedMonitors?: PlanOptions["archivedMonitors"]
}

function parseIfMatch(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Recomputes every client-derived value. The returned plan is authoritative and
 * is safe for an integration layer to use after acquiring its transaction lock.
 */
export function validateApplyPreconditions(
  input: ApplyPreconditionInput
): ConfigurationPlan {
  const { request } = input
  if (parseIfMatch(input.ifMatch) !== request.baseConfigHash) {
    throw new ConfigApplyError(
      "PRECONDITION_MISMATCH",
      "If-Match must equal body baseConfigHash"
    )
  }
  if (request.baseConfigHash !== input.currentConfigHash) {
    throw new ConfigApplyError(
      "CONFIG_VERSION_CONFLICT",
      "The monitor configuration changed after it was loaded"
    )
  }

  const authoritative = createConfigurationPlan(
    input.currentConfig,
    request.targetConfig,
    {
      baseConfigHash: input.currentConfigHash,
      archivedMonitors: input.archivedMonitors,
    }
  )
  if (request.targetConfigHash !== authoritative.targetConfigHash) {
    throw new ConfigApplyError(
      "TARGET_CONFIG_HASH_MISMATCH",
      "Target configuration hash does not match the supplied configuration"
    )
  }
  if (request.planHash !== authoritative.planHash) {
    throw new ConfigApplyError(
      "PLAN_HASH_MISMATCH",
      "Plan hash does not match the authoritative plan"
    )
  }
  const allowsDestructiveChanges = request.allowDestructiveChanges ?? false
  if (authoritative.destructiveConsentRequired && !allowsDestructiveChanges) {
    throw new ConfigApplyError(
      "DESTRUCTIVE_CONSENT_REQUIRED",
      "allowDestructiveChanges is required for this configuration plan"
    )
  }
  return authoritative
}
