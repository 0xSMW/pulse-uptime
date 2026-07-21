import type { DeclarativeConfig, MonitoringConfig } from "./schema"
import {
  validateDeclarativeConfig,
  validateMonitoringConfig,
} from "./validation"

export function exportDeclarativeConfig(
  acceptedInput: unknown
): DeclarativeConfig {
  const accepted = validateMonitoringConfig(acceptedInput)
  return validateDeclarativeConfig({
    version: 2,
    settings: accepted.settings,
    groups: accepted.groups,
    monitors: accepted.monitors,
  })
}

export function toMonitoringConfig(
  documentInput: unknown,
  configVersion: number
): MonitoringConfig {
  const document = validateDeclarativeConfig(documentInput)
  return validateMonitoringConfig({
    schemaVersion: 2,
    configVersion,
    settings: document.settings,
    groups: document.groups,
    monitors: document.monitors,
  })
}
