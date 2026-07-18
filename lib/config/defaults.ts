import type { MonitorConfig, MonitoringSettings } from "./schema";

export const DEFAULT_MONITOR_SETTINGS: Readonly<MonitoringSettings> = Object.freeze({
  concurrency: 25,
  defaultTimeoutMs: 8_000,
  defaultFailureThreshold: 2,
  defaultRecoveryThreshold: 2,
  defaultRecipients: [],
  userAgent: "Pulse/1.0",
});

export const DEFAULT_MONITOR_VALUES = Object.freeze({
  enabled: true,
  group: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8_000,
  expectedStatus: Object.freeze({ minimum: 200, maximum: 399 }),
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
} satisfies Omit<MonitorConfig, "id" | "name" | "url">);

export function createMonitorWithDefaults(
  required: Pick<MonitorConfig, "id" | "name" | "url">,
): MonitorConfig {
  return {
    ...required,
    ...DEFAULT_MONITOR_VALUES,
    expectedStatus: { ...DEFAULT_MONITOR_VALUES.expectedStatus },
    recipients: [],
  };
}

export function resolveMonitorRecipients(
  monitor: Pick<MonitorConfig, "recipients">,
  settings: Pick<MonitoringSettings, "defaultRecipients">,
): string[] {
  return [...(monitor.recipients.length === 0 ? settings.defaultRecipients : monitor.recipients)];
}
