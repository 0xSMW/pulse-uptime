import { parseConnectionString } from "@vercel/edge-config"

import {
  abortSignalForDeadline,
  deadlineIsExpired,
  deadlineRemainingMs,
} from "@/lib/async/deadline"

import type {
  ReadinessProbe,
  ReadinessProbeOptions,
  ReadinessResult,
} from "./types"

type DatabaseProbe = (options: ReadinessProbeOptions) => Promise<void>

type Fetcher = typeof fetch

const RESEND_API_BASE = "https://api.resend.com"

export function createVercelProbe(
  env: Record<string, string | undefined> = process.env
): ReadinessProbe {
  return async () => {
    const appUrl = env.NEXT_PUBLIC_APP_URL
    const required = [
      env.CRON_SECRET,
      env.EDGE_CONFIG,
      env.EDGE_CONFIG_ID,
      env.VERCEL_API_TOKEN,
    ]

    const secureUrl = (() => {
      try {
        return appUrl ? new URL(appUrl).protocol === "https:" : false
      } catch {
        return false
      }
    })()

    if (!secureUrl || required.some((value) => !value)) {
      return blocked(
        "vercel",
        "VERCEL_CONFIGURATION_INCOMPLETE",
        "Complete the Vercel environment setup"
      )
    }

    return ready("vercel", "VERCEL_READY")
  }
}

export function createDatabaseProbe(probe: DatabaseProbe): ReadinessProbe {
  return async (options) => {
    if (isDeadlineMissed(options)) {
      return blocked(
        "database",
        "DATABASE_TIMEOUT",
        "Check Neon connectivity and migrations"
      )
    }
    try {
      await probe(options)
      return ready("database", "DATABASE_READY")
    } catch {
      if (isDeadlineMissed(options)) {
        return blocked(
          "database",
          "DATABASE_TIMEOUT",
          "Check Neon connectivity and migrations"
        )
      }
      return blocked(
        "database",
        "DATABASE_UNAVAILABLE",
        "Connect Neon and run migrations"
      )
    }
  }
}

export function createEdgeConfigProbe(
  env: Record<string, string | undefined> = process.env,
  fetcher: Fetcher = fetch
): ReadinessProbe {
  return async (options) => {
    const connectionString = env.EDGE_CONFIG
    const configId = env.EDGE_CONFIG_ID
    const token = env.VERCEL_API_TOKEN
    if (!(connectionString && configId && token)) {
      return blocked(
        "edge",
        "EDGE_CONFIGURATION_INCOMPLETE",
        "Connect a writable Edge Config store"
      )
    }

    if (isDeadlineMissed(options)) {
      return blocked(
        "edge",
        "EDGE_TIMEOUT",
        "Check Edge Config read and write access"
      )
    }

    const connection = parseConnectionString(connectionString)
    if (!connection) {
      return blocked(
        "edge",
        "EDGE_CONFIGURATION_INCOMPLETE",
        "Connect a writable Edge Config store"
      )
    }

    try {
      const signal = probeSignal(options)
      // Direct fetch with abort. The Edge Config SDK getAll path cannot cancel.
      const readResponse = await fetcher(
        `${connection.baseUrl}/items?version=${connection.version}`,
        {
          headers: { Authorization: `Bearer ${connection.token}` },
          cache: "no-store",
          signal,
        }
      )
      if (!readResponse.ok) {
        throw new Error("Edge Config read failed")
      }
      await readResponse.json()

      const teamQuery = env.VERCEL_TEAM_ID
        ? `?teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}`
        : ""
      // Verify write access against a dedicated sentinel key. Never echo `monitoring`
      // back: reading it and PATCH-upserting the read value races a concurrent
      // legitimate config write and can silently roll it back.
      const writeResponse = await fetcher(
        `https://api.vercel.com/v1/edge-config/${encodeURIComponent(configId)}/items${teamQuery}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            items: [
              {
                operation: "upsert",
                key: "readinessProbe",
                value: { ok: true },
              },
            ],
          }),
          signal,
        }
      )
      if (!writeResponse.ok) {
        throw new Error("Edge Config write failed")
      }
      return ready("edge", "EDGE_READY")
    } catch {
      if (isDeadlineMissed(options)) {
        return blocked(
          "edge",
          "EDGE_TIMEOUT",
          "Check Edge Config read and write access"
        )
      }
      return blocked(
        "edge",
        "EDGE_UNAVAILABLE",
        "Check Edge Config read and write access"
      )
    }
  }
}

export function createEmailProbe(
  env: Record<string, string | undefined> = process.env,
  fetcher: Fetcher = fetch
): ReadinessProbe {
  return async (options) => {
    const key = env.RESEND_API_KEY
    const from = env.RESEND_FROM_EMAIL
    if (!(key && from)) {
      return emailWarning("EMAIL_CONFIGURATION_INCOMPLETE")
    }

    if (isDeadlineMissed(options)) {
      return emailWarning("EMAIL_TIMEOUT")
    }

    try {
      const domain = from.split("@")[1]?.toLowerCase()
      if (!domain) {
        return emailWarning("EMAIL_SENDER_INVALID")
      }

      const signal = probeSignal(options)
      const headers = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      }
      // Direct fetch with abort. The Resend SDK list/send path cannot cancel.
      const listResponse = await fetcher(`${RESEND_API_BASE}/domains`, {
        method: "GET",
        headers,
        signal,
      })

      if (!listResponse.ok) {
        const delivery = await sendReadinessEmail({
          fetcher,
          headers,
          from,
          domain,
          signal,
        })
        return delivery
          ? ready("email", "EMAIL_READY")
          : emailWarning("EMAIL_API_UNAVAILABLE")
      }

      const listBody = (await listResponse.json()) as {
        data?: Array<{ name?: string; status?: string }>
      }
      const verified = listBody.data?.some(
        (entry) =>
          entry.name?.toLowerCase() === domain && entry.status === "verified"
      )
      return verified
        ? ready("email", "EMAIL_READY")
        : emailWarning("EMAIL_DOMAIN_UNVERIFIED")
    } catch {
      if (isDeadlineMissed(options)) {
        return emailWarning("EMAIL_TIMEOUT")
      }
      return emailWarning("EMAIL_API_UNAVAILABLE")
    }
  }
}

async function sendReadinessEmail(input: {
  fetcher: Fetcher
  headers: Record<string, string>
  from: string
  domain: string
  signal: AbortSignal
}): Promise<boolean> {
  const response = await input.fetcher(`${RESEND_API_BASE}/emails`, {
    method: "POST",
    headers: {
      ...input.headers,
      "Idempotency-Key": `pulse-readiness-${input.domain}`,
    },
    body: JSON.stringify({
      from: input.from,
      to: "delivered@resend.dev",
      subject: "Pulse email readiness check",
      text: "Pulse verified this sender for outage and recovery alerts.",
    }),
    signal: input.signal,
  })
  if (!response.ok) {
    return false
  }
  const body = (await response.json()) as { id?: string }
  return typeof body.id === "string"
}

function probeSignal(options: ReadinessProbeOptions): AbortSignal {
  if (options.signal.aborted) {
    return options.signal
  }
  const remaining = deadlineRemainingMs(options.deadlineAtMs)
  if (remaining <= 0) {
    return abortSignalForDeadline(options.deadlineAtMs)
  }
  // Keep the caller's signal and clamp to remaining budget so late probes abort.
  return AbortSignal.any([
    options.signal,
    abortSignalForDeadline(options.deadlineAtMs),
  ])
}

function isDeadlineMissed(options: ReadinessProbeOptions): boolean {
  return options.signal.aborted || deadlineIsExpired(options.deadlineAtMs)
}

function ready(
  system: ReadinessResult["system"],
  code: string
): ReadinessResult {
  return { system, state: "ready", code }
}

function blocked(
  system: ReadinessResult["system"],
  code: string,
  remediation: string
): ReadinessResult {
  return { system, state: "blocked", code, remediation }
}

function emailWarning(code: string): ReadinessResult {
  return {
    system: "email",
    state: "warning",
    code,
    remediation: "Verify your Resend sender",
  }
}
