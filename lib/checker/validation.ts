import { z } from "zod"

import { isPublicHttpUrl } from "@/lib/net/public-url"

import {
  assertPublicAddress,
  isIpLiteral,
  normalizeIpLiteral,
} from "./ip-policy"

export class MonitorValidationError extends Error {
  constructor(
    readonly issues: string[],
    options?: ErrorOptions
  ) {
    super(issues.join("; "), options)
    this.name = "MonitorValidationError"
  }
}

export function parsePublicHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new MonitorValidationError(["url must be a valid absolute URL"], {
      cause: error,
    })
  }

  // Screen IP literals first so a syntactically valid but non-routable address
  // (loopback, private, reserved) is classified BLOCKED_TARGET rather than being
  // flattened into a generic INVALID_URL by the shared policy below.
  if (isIpLiteral(url.hostname)) {
    assertPublicAddress(normalizeIpLiteral(url.hostname))
  }
  if (!isPublicHttpUrl(value)) {
    throw new MonitorValidationError(["url must be a public HTTP or HTTPS URL"])
  }
  return url
}

const publicUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      parsePublicHttpUrl(value)
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid URL",
      })
    }
  })

const checkTargetSchema = z
  .object({
    url: publicUrlSchema,
    method: z.enum(["GET", "HEAD"]),
    timeoutMs: z.number().int().min(1000).max(15_000),
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
  .strict()

const emailSchema = z.string().email()

const monitorConfigSchema = checkTargetSchema
  .extend({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    group: z.string().trim().min(1).max(50).nullable(),
    intervalMinutes: z.union([
      z.literal(1),
      z.literal(5),
      z.literal(10),
      z.literal(15),
    ]),
    failureThreshold: z.number().int().min(1).max(5),
    recoveryThreshold: z.number().int().min(1).max(5),
    recipients: z.array(emailSchema).max(20),
  })
  .strict()

export function validateCheckTarget(value: unknown) {
  const parsed = checkTargetSchema.safeParse(value)
  if (!parsed.success) {
    throw new MonitorValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "target"}: ${issue.message}`
      )
    )
  }
  return parsed.data
}

export function validateMonitorConfig(value: unknown) {
  const parsed = monitorConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new MonitorValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "monitor"}: ${issue.message}`
      )
    )
  }
  return parsed.data
}
