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
    expectedText: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (target) => target.expectedText === undefined || target.method === "GET",
    {
      message: "expectedText requires method GET",
      path: ["expectedText"],
    }
  )

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
