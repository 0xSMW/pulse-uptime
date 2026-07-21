import {
  type ReadinessProbe,
  type ReadinessProbeOptions,
  type ReadinessReport,
  type ReadinessResult,
  readinessSystems,
} from "./types"

const RESULT_TTL_MS = 60_000

export async function runReadinessChecks(
  probes: Record<(typeof readinessSystems)[number], ReadinessProbe>,
  options: ReadinessProbeOptions,
  now = new Date()
): Promise<ReadinessReport> {
  const results = await Promise.all(
    readinessSystems.map(async (system): Promise<ReadinessResult> => {
      try {
        const result = await probes[system](options)
        return { ...result, system }
      } catch {
        return failureFor(system)
      }
    })
  )

  const blocked = results.some((result) => result.state === "blocked")
  const emailWarning = results.some(
    (result) => result.system === "email" && result.state === "warning"
  )

  return {
    checkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    canContinue: !blocked,
    requiresEmailAcknowledgement: !blocked && emailWarning,
    checks: results,
  }
}

function failureFor(
  system: (typeof readinessSystems)[number]
): ReadinessResult {
  if (system === "email") {
    return {
      system,
      state: "warning",
      code: "EMAIL_UNAVAILABLE",
      remediation: "Verify your Resend sender",
    }
  }

  const remediation: Record<Exclude<typeof system, "email">, string> = {
    vercel: "Complete the Vercel environment setup",
    database: "Connect Neon and run migrations",
    edge: "Connect a writable Edge Config store",
  }

  return {
    system,
    state: "blocked",
    code: `${system.toUpperCase()}_UNAVAILABLE`,
    remediation: remediation[system],
  }
}
