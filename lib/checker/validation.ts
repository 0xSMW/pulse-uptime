import { z } from "zod";

import { assertPublicAddress, isIpLiteral, normalizeIpLiteral } from "./ip-policy";

export class MonitorValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "MonitorValidationError";
  }
}

export function parsePublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MonitorValidationError(["url must be a valid absolute URL"]);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MonitorValidationError(["url must use HTTP or HTTPS"]);
  }
  if (!url.hostname) throw new MonitorValidationError(["url must include a hostname"]);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new MonitorValidationError(["url hostname must not be localhost"]);
  }
  if (url.username || url.password) {
    throw new MonitorValidationError(["url must not include credentials"]);
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new MonitorValidationError(["url port must be 80 or 443"]);
  }
  if (url.protocol === "http:" && url.port === "443") {
    throw new MonitorValidationError(["HTTP URLs must use port 80"]);
  }
  if (url.protocol === "https:" && url.port === "80") {
    throw new MonitorValidationError(["HTTPS URLs must use port 443"]);
  }
  if (isIpLiteral(url.hostname)) assertPublicAddress(normalizeIpLiteral(url.hostname));
  return url;
}

const publicUrlSchema = z.string().min(1).superRefine((value, context) => {
  try {
    parsePublicHttpUrl(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid URL",
    });
  }
});

export const checkTargetSchema = z
  .object({
    url: publicUrlSchema,
    method: z.enum(["GET", "HEAD"]),
    timeoutMs: z.number().int().min(1_000).max(15_000),
    expectedStatus: z
      .object({
        minimum: z.number().int().min(100).max(599),
        maximum: z.number().int().min(100).max(599),
      })
      .strict()
      .refine(({ minimum, maximum }) => maximum >= minimum, {
        message: "maximum must be greater than or equal to minimum",
        path: ["maximum"],
      }),
  })
  .strict();

const emailSchema = z.string().email();

export const monitorConfigSchema = checkTargetSchema.extend({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  group: z.string().trim().min(1).max(50).nullable(),
  intervalMinutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)]),
  failureThreshold: z.number().int().min(1).max(5),
  recoveryThreshold: z.number().int().min(1).max(5),
  recipients: z.array(emailSchema).max(20),
}).strict();

export function validateCheckTarget(value: unknown) {
  const parsed = checkTargetSchema.safeParse(value);
  if (!parsed.success) {
    throw new MonitorValidationError(parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "target"}: ${issue.message}`));
  }
  return parsed.data;
}

export function validateMonitorConfig(value: unknown) {
  const parsed = monitorConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new MonitorValidationError(parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "monitor"}: ${issue.message}`));
  }
  return parsed.data;
}
