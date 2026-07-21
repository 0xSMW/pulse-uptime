import { describe, expect, it } from "vitest"

import { createVercelProbe } from "./probes"
import { runReadinessChecks } from "./service"
import type {
  ReadinessProbe,
  ReadinessProbeOptions,
  ReadinessResult,
} from "./types"

function probe(result: ReadinessResult): ReadinessProbe {
  return async () => result
}

function options(
  overrides: Partial<ReadinessProbeOptions> = {}
): ReadinessProbeOptions {
  return {
    deadlineAtMs: Date.now() + 9000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("readiness orchestration", () => {
  it("runs probes concurrently and returns them in UI order", async () => {
    const report = await runReadinessChecks(
      {
        vercel: probe({ system: "vercel", state: "ready", code: "OK" }),
        database: probe({ system: "database", state: "ready", code: "OK" }),
        edge: probe({ system: "edge", state: "ready", code: "OK" }),
        email: probe({ system: "email", state: "ready", code: "OK" }),
      },
      options(),
      new Date("2026-07-18T00:00:00.000Z")
    )
    expect(report.checks.map(({ system }) => system)).toEqual([
      "vercel",
      "database",
      "edge",
      "email",
    ])
    expect(report.canContinue).toBe(true)
    expect(report.expiresAt).toBe("2026-07-18T00:01:00.000Z")
  })

  it("allows an explicit email-warning path", async () => {
    const report = await runReadinessChecks(
      {
        vercel: probe({ system: "vercel", state: "ready", code: "OK" }),
        database: probe({ system: "database", state: "ready", code: "OK" }),
        edge: probe({ system: "edge", state: "ready", code: "OK" }),
        email: probe({
          system: "email",
          state: "warning",
          code: "EMAIL_UNAVAILABLE",
          remediation: "Verify your Resend sender",
        }),
      },
      options()
    )
    expect(report.canContinue).toBe(true)
    expect(report.requiresEmailAcknowledgement).toBe(true)
  })

  it("blocks for required systems", async () => {
    const report = await runReadinessChecks(
      {
        vercel: probe({ system: "vercel", state: "ready", code: "OK" }),
        database: probe({
          system: "database",
          state: "blocked",
          code: "DATABASE_UNAVAILABLE",
        }),
        edge: probe({ system: "edge", state: "ready", code: "OK" }),
        email: probe({ system: "email", state: "ready", code: "OK" }),
      },
      options()
    )
    expect(report.canContinue).toBe(false)
  })

  it("never exposes provider exceptions", async () => {
    const broken: ReadinessProbe = async () => {
      throw new Error("postgresql://secret@database")
    }
    const report = await runReadinessChecks(
      {
        vercel: probe({ system: "vercel", state: "ready", code: "OK" }),
        database: broken,
        edge: probe({ system: "edge", state: "ready", code: "OK" }),
        email: probe({ system: "email", state: "ready", code: "OK" }),
      },
      options()
    )
    expect(JSON.stringify(report)).not.toContain("secret")
    expect(report.checks[1]?.code).toBe("DATABASE_UNAVAILABLE")
  })
})

describe("Vercel readiness probe", () => {
  it("requires HTTPS and the deployment variables", async () => {
    await expect(
      createVercelProbe({
        NEXT_PUBLIC_APP_URL: "https://pulse.example.com",
        CRON_SECRET: "secret",
        EDGE_CONFIG: "https://edge-config.example",
        EDGE_CONFIG_ID: "ecfg_1",
        VERCEL_API_TOKEN: "token",
      })(options())
    ).resolves.toMatchObject({ state: "ready" })

    await expect(
      createVercelProbe({
        NEXT_PUBLIC_APP_URL: "http://pulse.example.com",
      })(options())
    ).resolves.toMatchObject({
      state: "blocked",
      code: "VERCEL_CONFIGURATION_INCOMPLETE",
    })
  })
})
