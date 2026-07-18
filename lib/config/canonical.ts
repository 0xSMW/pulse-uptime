import { createHash } from "node:crypto";
import { MAX_CONFIG_BYTES, type DeclarativeConfig, type MonitorConfig, type MonitoringConfig } from "./schema";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function normalizeRecipients(recipients: string[]): string[] {
  return [...new Set(recipients.map((email) => email.trim().toLowerCase()))].sort(compareLexically);
}

export function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeMonitor(monitor: MonitorConfig): MonitorConfig {
  const url = new URL(monitor.url);
  url.hostname = url.hostname.toLowerCase();
  return {
    ...monitor,
    name: monitor.name.trim(),
    url: url.toString(),
    group: monitor.group?.trim() || null,
    expectedStatus: { ...monitor.expectedStatus },
    recipients: normalizeRecipients(monitor.recipients),
  };
}

export function normalizeDeclarativeConfig(config: DeclarativeConfig): DeclarativeConfig {
  return {
    version: 1,
    settings: {
      ...config.settings,
      defaultRecipients: normalizeRecipients(config.settings.defaultRecipients),
      userAgent: config.settings.userAgent.trim(),
    },
    monitors: config.monitors.map(normalizeMonitor).sort((a, b) => compareLexically(a.id, b.id)),
  };
}

export function normalizeMonitoringConfig(config: MonitoringConfig): MonitoringConfig {
  const document = normalizeDeclarativeConfig({ version: 1, settings: config.settings, monitors: config.monitors });
  return { schemaVersion: 1, configVersion: config.configVersion, settings: document.settings, monitors: document.monitors };
}

export function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalSerialize(value), "utf8");
}

export function assertConfigSize(value: unknown): void {
  const bytes = serializedByteLength(value);
  if (bytes > MAX_CONFIG_BYTES) throw new ConfigSizeError(bytes, MAX_CONFIG_BYTES);
}

export class ConfigSizeError extends Error {
  readonly code = "CONFIG_TOO_LARGE";
  constructor(readonly actualBytes: number, readonly maximumBytes: number) {
    super(`Serialized configuration is ${actualBytes} bytes; maximum is ${maximumBytes}`);
    this.name = "ConfigSizeError";
  }
}
