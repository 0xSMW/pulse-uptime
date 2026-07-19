import { z } from "zod";

export const MONITOR_INTERVALS = [1, 5, 10, 15] as const;
export const MAX_ACTIVE_MONITORS = 100;
export const MAX_MONITOR_GROUPS = 100;
export const MAX_CONFIG_BYTES = 55 * 1024;

const emailSchema = z.string().trim().email();
const recipientsSchema = z.array(emailSchema).max(20);

// C0/C1 control characters and Unicode bidi controls must never survive into stored
// display fields: downstream consumers (the CLI's terminal/TSV output, logs) render
// them verbatim, so an ESC or bidi override in a monitor name becomes ANSI injection
// or forged tabular rows. Reject them at the trust boundary.
const DISPLAY_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export function displayName(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !DISPLAY_CONTROL_CHARS.test(value), "Must not contain control characters");
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return false;
    }

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".localhost")) return false;

    // DNS resolution and rebinding protection belong to the secure checker. These
    // checks reject literal addresses that are never valid public destinations.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const octets = host.split(".").map(Number);
      if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255)) return false;
      const [a, b, c] = octets;
      return !(
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113)
      );
    }

    if (host.includes(":")) {
      const compact = host.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
      return !(
        compact === "::" || compact === "::1" ||
        compact.startsWith("fc") || compact.startsWith("fd") ||
        compact.startsWith("fe8") || compact.startsWith("fe9") ||
        compact.startsWith("fea") || compact.startsWith("feb") ||
        compact.startsWith("ff") || compact.startsWith("::ffff:") ||
        compact.startsWith("2001:db8:")
      );
    }

    return true;
  } catch {
    return false;
  }
}

export const expectedStatusSchema = z.object({
  minimum: z.number().int().min(100).max(599),
  maximum: z.number().int().min(100).max(599),
}).strict().refine(({ minimum, maximum }) => maximum >= minimum, {
  message: "Expected status maximum must be greater than or equal to minimum",
  path: ["maximum"],
});

export const groupConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase slug").min(3).max(64),
  name: displayName(1, 50),
}).strict();

const monitorFields = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase slug").min(3).max(64),
  name: displayName(1, 80),
  url: z.string().refine(isPublicHttpUrl, "Must be a public HTTP or HTTPS URL"),
  enabled: z.boolean(),
  method: z.enum(["GET", "HEAD"]),
  intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)]),
  timeoutMs: z.number().int().min(1_000).max(15_000),
  expectedStatus: expectedStatusSchema,
  failureThreshold: z.number().int().min(1).max(5),
  recoveryThreshold: z.number().int().min(1).max(5),
  recipients: recipientsSchema,
} as const;

export const monitorConfigSchema = z.object({
  ...monitorFields,
  groupId: groupConfigSchema.shape.id.nullable(),
}).strict();

export const legacyMonitorConfigSchema = z.object({
  ...monitorFields,
  group: displayName(1, 50).nullable(),
}).strict();

export const monitoringSettingsSchema = z.object({
  concurrency: z.number().int().min(1),
  defaultTimeoutMs: z.number().int().min(1_000).max(15_000),
  defaultFailureThreshold: z.number().int().min(1).max(5),
  defaultRecoveryThreshold: z.number().int().min(1).max(5),
  defaultRecipients: recipientsSchema,
  userAgent: z.string().trim().min(1),
}).strict();

function validateMonitorCollection(
  value: { groups: Array<{ id: string; name: string }>; monitors: Array<{ id: string; enabled: boolean; groupId: string | null }> },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  value.monitors.forEach((monitor, index) => {
    if (seen.has(monitor.id)) {
      context.addIssue({ code: "custom", message: "Monitor IDs must be unique", path: ["monitors", index, "id"] });
    }
    seen.add(monitor.id);
  });

  if (value.monitors.filter((monitor) => monitor.enabled).length > MAX_ACTIVE_MONITORS) {
    context.addIssue({ code: "custom", message: `At most ${MAX_ACTIVE_MONITORS} monitors may be active`, path: ["monitors"] });
  }

  if (value.groups.length > MAX_MONITOR_GROUPS) {
    context.addIssue({ code: "custom", message: `At most ${MAX_MONITOR_GROUPS} groups may be configured`, path: ["groups"] });
  }
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  value.groups.forEach((group, index) => {
    if (groupIds.has(group.id)) context.addIssue({ code: "custom", message: "Group IDs must be unique", path: ["groups", index, "id"] });
    groupIds.add(group.id);
    const foldedName = group.name.trim().toLocaleLowerCase("en-US");
    if (groupNames.has(foldedName)) context.addIssue({ code: "custom", message: "Group names must be unique", path: ["groups", index, "name"] });
    groupNames.add(foldedName);
  });
  value.monitors.forEach((monitor, index) => {
    if (monitor.groupId !== null && !groupIds.has(monitor.groupId)) {
      context.addIssue({ code: "custom", message: "Monitor group must exist", path: ["monitors", index, "groupId"] });
    }
  });
}

export const monitoringConfigSchema = z.object({
  schemaVersion: z.literal(2),
  configVersion: z.number().int().nonnegative(),
  settings: monitoringSettingsSchema,
  groups: z.array(groupConfigSchema),
  monitors: z.array(monitorConfigSchema),
}).strict().superRefine(validateMonitorCollection);

export const declarativeConfigSchema = z.object({
  version: z.literal(2),
  settings: monitoringSettingsSchema,
  groups: z.array(groupConfigSchema),
  monitors: z.array(monitorConfigSchema),
}).strict().superRefine(validateMonitorCollection);

function validateLegacyMonitorCollection(
  value: { monitors: Array<{ id: string; enabled: boolean }> },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  value.monitors.forEach((monitor, index) => {
    if (seen.has(monitor.id)) context.addIssue({ code: "custom", message: "Monitor IDs must be unique", path: ["monitors", index, "id"] });
    seen.add(monitor.id);
  });
  if (value.monitors.filter((monitor) => monitor.enabled).length > MAX_ACTIVE_MONITORS) {
    context.addIssue({ code: "custom", message: `At most ${MAX_ACTIVE_MONITORS} monitors may be active`, path: ["monitors"] });
  }
}

export const legacyMonitoringConfigSchema = z.object({
  schemaVersion: z.literal(1), configVersion: z.number().int().nonnegative(),
  settings: monitoringSettingsSchema, monitors: z.array(legacyMonitorConfigSchema),
}).strict().superRefine(validateLegacyMonitorCollection);

export const legacyDeclarativeConfigSchema = z.object({
  version: z.literal(1), settings: monitoringSettingsSchema, monitors: z.array(legacyMonitorConfigSchema),
}).strict().superRefine(validateLegacyMonitorCollection);

export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export type GroupConfig = z.infer<typeof groupConfigSchema>;
export type LegacyMonitorConfig = z.infer<typeof legacyMonitorConfigSchema>;
export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;
export type MonitoringConfig = z.infer<typeof monitoringConfigSchema>;
export type DeclarativeConfig = z.infer<typeof declarativeConfigSchema>;
export type LegacyMonitoringConfig = z.infer<typeof legacyMonitoringConfigSchema>;
export type LegacyDeclarativeConfig = z.infer<typeof legacyDeclarativeConfigSchema>;
