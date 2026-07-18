import { z } from "zod";
import { assertConfigSize, normalizeDeclarativeConfig, normalizeMonitoringConfig } from "./canonical";
import {
  declarativeConfigSchema,
  monitoringConfigSchema,
  type DeclarativeConfig,
  type MonitoringConfig,
} from "./schema";

export function validateDeclarativeConfig(input: unknown): DeclarativeConfig {
  const parsed = declarativeConfigSchema.parse(input);
  const normalized = normalizeDeclarativeConfig(parsed);
  assertConfigSize(normalized);
  return normalized;
}

export function validateMonitoringConfig(input: unknown): MonitoringConfig {
  const parsed = monitoringConfigSchema.parse(input);
  const normalized = normalizeMonitoringConfig(parsed);
  assertConfigSize(normalized);
  return normalized;
}

export function safeValidateDeclarativeConfig(input: unknown):
  | { success: true; data: DeclarativeConfig }
  | { success: false; error: z.ZodError | Error } {
  try {
    return { success: true, data: validateDeclarativeConfig(input) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error("Invalid configuration") };
  }
}

