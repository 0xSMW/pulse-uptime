import { createHash } from "node:crypto"
import {
  assertConfigSize,
  normalizeDeclarativeConfig,
  normalizeMonitoringConfig,
} from "./canonical"
import {
  type DeclarativeConfig,
  declarativeConfigSchema,
  legacyDeclarativeConfigSchema,
  legacyMonitoringConfigSchema,
  type MonitoringConfig,
  monitoringConfigSchema,
} from "./schema"

function legacyGroupId(name: string): string {
  return `group-${createHash("sha256").update(name.trim().toLocaleLowerCase("en-US")).digest("hex").slice(0, 12)}`
}

function adaptLegacyDeclarativeConfig(input: unknown): DeclarativeConfig {
  const legacy = legacyDeclarativeConfigSchema.parse(input)
  const namesByFolded = new Map<string, string>()
  for (const monitor of legacy.monitors) {
    const name = monitor.group?.trim()
    if (name) {
      const folded = name.toLocaleLowerCase("en-US")
      if (!namesByFolded.has(folded)) {
        namesByFolded.set(folded, name)
      }
    }
  }
  const groups = [...namesByFolded].map(([folded, name]) => ({
    id: legacyGroupId(folded),
    name,
  }))
  const ids = new Map(
    groups.map((group) => [group.name.toLocaleLowerCase("en-US"), group.id])
  )
  return validateDeclarativeConfig({
    version: 2,
    settings: legacy.settings,
    groups,
    monitors: legacy.monitors.map(({ group, ...monitor }) => ({
      ...monitor,
      groupId: group ? ids.get(group.trim().toLocaleLowerCase("en-US"))! : null,
    })),
  })
}

export function validateDeclarativeConfig(input: unknown): DeclarativeConfig {
  if (
    typeof input === "object" &&
    input !== null &&
    (input as { version?: unknown }).version === 1
  ) {
    return adaptLegacyDeclarativeConfig(input)
  }
  const parsed = declarativeConfigSchema.parse(input)
  const normalized = normalizeDeclarativeConfig(parsed)
  assertConfigSize(normalized)
  return normalized
}

export function validateMonitoringConfig(input: unknown): MonitoringConfig {
  if (
    typeof input === "object" &&
    input !== null &&
    (input as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    const legacy = legacyMonitoringConfigSchema.parse(input)
    const document = adaptLegacyDeclarativeConfig({
      version: 1,
      settings: legacy.settings,
      monitors: legacy.monitors,
    })
    return normalizeMonitoringConfig({
      schemaVersion: 2,
      configVersion: legacy.configVersion,
      settings: document.settings,
      groups: document.groups,
      monitors: document.monitors,
    })
  }
  const parsed = monitoringConfigSchema.parse(input)
  const normalized = normalizeMonitoringConfig(parsed)
  assertConfigSize(normalized)
  return normalized
}
