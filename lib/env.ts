import { z } from "zod"

import { DEFAULT_STATUS_PAGE_NAME } from "@/lib/status-page/schema"

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  EDGE_CONFIG: z.string().url(),
  EDGE_CONFIG_ID: z.string().min(1),
  VERCEL_API_TOKEN: z.string().min(1),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().startsWith("re_"),
  RESEND_FROM_EMAIL: z.string().email(),
  API_TOKEN_HASH_KEY: z.string().min(32),
  DEVICE_AUTH_SECRET: z.string().min(32),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_STATUS_PAGE_NAME: z
    .string()
    .min(1)
    .default(DEFAULT_STATUS_PAGE_NAME),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

export function parseServerEnv(
  source: Record<string, string | undefined> = process.env
): ServerEnv {
  return serverEnvSchema.parse(source)
}
