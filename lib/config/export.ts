import type { DeclarativeConfig, MonitoringConfig } from "./schema";
import { validateDeclarativeConfig, validateMonitoringConfig } from "./validation";

export function exportDeclarativeConfig(acceptedInput: unknown): DeclarativeConfig {
  const accepted = validateMonitoringConfig(acceptedInput);
  return validateDeclarativeConfig({ version: 1, settings: accepted.settings, monitors: accepted.monitors });
}

export function toMonitoringConfig(documentInput: unknown, configVersion: number): MonitoringConfig {
  const document = validateDeclarativeConfig(documentInput);
  return validateMonitoringConfig({
    schemaVersion: 1,
    configVersion,
    settings: document.settings,
    monitors: document.monitors,
  });
}

