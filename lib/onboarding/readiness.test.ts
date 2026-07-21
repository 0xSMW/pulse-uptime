import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  withStatementTimeout,
  createVercelProbe,
  createDatabaseProbe,
  createEdgeConfigProbe,
  createEmailProbe,
  runReadinessChecks,
} = vi.hoisted(() => ({
  withStatementTimeout: vi.fn(),
  createVercelProbe: vi.fn(),
  createDatabaseProbe: vi.fn(),
  createEdgeConfigProbe: vi.fn(),
  createEmailProbe: vi.fn(),
  runReadinessChecks: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/query-executor", () => ({
  queryExecutor: { withStatementTimeout },
}))
vi.mock("@/lib/readiness/probes", () => ({
  createVercelProbe,
  createDatabaseProbe,
  createEdgeConfigProbe,
  createEmailProbe,
}))
vi.mock("@/lib/readiness/service", () => ({
  runReadinessChecks,
}))

import type {
  ReadinessProbeOptions,
  ReadinessReport,
} from "@/lib/readiness/types"

import {
  getOnboardingReadiness,
  getOnboardingReadinessInFlightForTests,
  resetOnboardingReadinessCache,
  syncOnboardingReadiness,
} from "./readiness"

function report(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    checkedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T00:01:00.000Z",
    canContinue: true,
    requiresEmailAcknowledgement: false,
    checks: [
      { system: "vercel", state: "ready", code: "VERCEL_READY" },
      { system: "database", state: "ready", code: "DATABASE_READY" },
      { system: "edge", state: "ready", code: "EDGE_READY" },
      { system: "email", state: "ready", code: "EMAIL_READY" },
    ],
    ...overrides,
  }
}

function readyProbe(system: "vercel" | "database" | "edge" | "email") {
  return vi.fn(async () => ({
    system,
    state: "ready" as const,
    code: `${system.toUpperCase()}_READY`,
  }))
}

describe("onboarding readiness cache and in-flight coalescing", () => {
  beforeEach(() => {
    resetOnboardingReadinessCache()
    withStatementTimeout.mockReset()
    createVercelProbe.mockReset()
    createDatabaseProbe.mockReset()
    createEdgeConfigProbe.mockReset()
    createEmailProbe.mockReset()
    runReadinessChecks.mockReset()

    createVercelProbe.mockReturnValue(readyProbe("vercel"))
    createDatabaseProbe.mockImplementation(
      (probe: (options: ReadinessProbeOptions) => Promise<void>) =>
        async (options: ReadinessProbeOptions) => {
          await probe(options)
          return {
            system: "database",
            state: "ready",
            code: "DATABASE_READY",
          }
        }
    )
    createEdgeConfigProbe.mockReturnValue(readyProbe("edge"))
    createEmailProbe.mockReturnValue(readyProbe("email"))
  })

  afterEach(() => {
    resetOnboardingReadinessCache()
  })

  it("coalesces 10 concurrent cold loads into one probe execution", async () => {
    let release!: (value: ReadinessReport) => void
    const barrier = new Promise<ReadinessReport>((resolve) => {
      release = resolve
    })
    runReadinessChecks.mockReturnValueOnce(barrier)

    const loads = Array.from({ length: 10 }, () => getOnboardingReadiness())
    await Promise.resolve()
    expect(runReadinessChecks).toHaveBeenCalledTimes(1)
    expect(getOnboardingReadinessInFlightForTests()).not.toBeNull()

    const value = report()
    release(value)
    const results = await Promise.all(loads)
    expect(results.every((entry) => entry === value)).toBe(true)
    expect(getOnboardingReadinessInFlightForTests()).toBeNull()
  })

  it("clears in-flight after success and serves the completed cache", async () => {
    const value = report()
    runReadinessChecks.mockResolvedValueOnce(value)

    await expect(getOnboardingReadiness()).resolves.toBe(value)
    expect(getOnboardingReadinessInFlightForTests()).toBeNull()

    await expect(getOnboardingReadiness()).resolves.toBe(value)
    expect(runReadinessChecks).toHaveBeenCalledTimes(1)
  })

  it("clears in-flight after failure and does not cache the error", async () => {
    runReadinessChecks
      .mockRejectedValueOnce(new Error("provider boom"))
      .mockResolvedValueOnce(report())

    await expect(getOnboardingReadiness()).rejects.toThrow("provider boom")
    expect(getOnboardingReadinessInFlightForTests()).toBeNull()

    await expect(getOnboardingReadiness()).resolves.toMatchObject({
      canContinue: true,
    })
    expect(runReadinessChecks).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed probe execution as success", async () => {
    runReadinessChecks.mockRejectedValueOnce(new Error("nope"))

    await expect(getOnboardingReadiness()).rejects.toThrow("nope")

    const value = report({ canContinue: false })
    runReadinessChecks.mockResolvedValueOnce(value)
    await expect(getOnboardingReadiness()).resolves.toBe(value)
  })

  it("does not cache a completed report when canContinue is false", async () => {
    const blocked = report({ canContinue: false })
    const ready = report({ canContinue: true })
    runReadinessChecks
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce(ready)

    await expect(getOnboardingReadiness()).resolves.toBe(blocked)
    await expect(getOnboardingReadiness()).resolves.toBe(ready)
    expect(runReadinessChecks).toHaveBeenCalledTimes(2)
  })

  it("binds the shared flight to a deadline signal, not the caller signal", async () => {
    const caller = new AbortController()
    let seenSignal: AbortSignal | undefined
    runReadinessChecks.mockImplementation(async (_probes, options) => {
      seenSignal = options.signal
      return report()
    })

    await getOnboardingReadiness({
      deadlineAtMs: Date.now() + 5000,
      signal: caller.signal,
    })

    expect(seenSignal).toBeDefined()
    expect(seenSignal).not.toBe(caller.signal)
    caller.abort()
    expect(seenSignal?.aborted).toBe(false)
  })
})

describe("syncOnboardingReadiness deadlines and DB probe", () => {
  beforeEach(() => {
    resetOnboardingReadinessCache()
    withStatementTimeout.mockReset()
    createVercelProbe.mockReset()
    createDatabaseProbe.mockReset()
    createEdgeConfigProbe.mockReset()
    createEmailProbe.mockReset()
    runReadinessChecks.mockReset()

    createVercelProbe.mockReturnValue(readyProbe("vercel"))
    createEdgeConfigProbe.mockReturnValue(readyProbe("edge"))
    createEmailProbe.mockReturnValue(readyProbe("email"))
  })

  afterEach(() => {
    resetOnboardingReadinessCache()
  })

  it("passes absolute deadline and abort signal into every probe", async () => {
    const deadlineAtMs = 1_700_000_000_000
    const controller = new AbortController()
    createDatabaseProbe.mockImplementation(() => readyProbe("database"))
    runReadinessChecks.mockImplementation(async (probes, options) => {
      expect(options.deadlineAtMs).toBe(deadlineAtMs)
      expect(options.signal).toBe(controller.signal)
      await probes.vercel(options)
      await probes.database(options)
      await probes.edge(options)
      await probes.email(options)
      return report()
    })

    await syncOnboardingReadiness({
      deadlineAtMs,
      signal: controller.signal,
    })

    expect(runReadinessChecks).toHaveBeenCalledTimes(1)
  })

  it("runs the database probe with one statement_timeout transaction and rolls back the temp table", async () => {
    const queries: string[] = []
    withStatementTimeout.mockImplementation(
      async (
        timeoutMs: number,
        work: (
          query: (text: string, values: readonly unknown[]) => Promise<unknown>
        ) => Promise<unknown>
      ) => {
        expect(timeoutMs).toBeGreaterThan(0)
        const query = async (text: string) => {
          queries.push(text)
          return []
        }
        return work(query)
      }
    )

    createDatabaseProbe.mockImplementation(
      (probe: (options: ReadinessProbeOptions) => Promise<void>) =>
        async (options: ReadinessProbeOptions) => {
          await probe(options)
          return {
            system: "database",
            state: "ready",
            code: "DATABASE_READY",
          }
        }
    )
    runReadinessChecks.mockImplementation(async (probes, options) => {
      await probes.database(options)
      return report()
    })

    await syncOnboardingReadiness({
      deadlineAtMs: Date.now() + 2500,
      signal: new AbortController().signal,
    })

    expect(withStatementTimeout).toHaveBeenCalledTimes(1)
    expect(queries).toEqual([
      "select id from admin_users limit 1",
      "create temporary table pulse_readiness_probe (id integer) on commit drop",
      "insert into pulse_readiness_probe (id) values (1)",
    ])
  })

  it("uses remaining deadline budget for the database statement_timeout", async () => {
    const deadlineAtMs = Date.now() + 1800
    withStatementTimeout.mockImplementation(
      async (
        timeoutMs: number,
        work: (
          query: (text: string, values: readonly unknown[]) => Promise<unknown>
        ) => Promise<unknown>
      ) => {
        expect(timeoutMs).toBeLessThanOrEqual(1800)
        expect(timeoutMs).toBeGreaterThan(0)
        const query = async () => []
        try {
          await work(query)
        } catch {
          // deliberate readiness rollback
        }
      }
    )
    createDatabaseProbe.mockImplementation(
      (probe: (options: ReadinessProbeOptions) => Promise<void>) =>
        async (options: ReadinessProbeOptions) => {
          await probe(options)
          return {
            system: "database",
            state: "ready",
            code: "DATABASE_READY",
          }
        }
    )
    runReadinessChecks.mockImplementation(async (probes, options) => {
      await probes.database(options)
      return report()
    })

    await syncOnboardingReadiness({
      deadlineAtMs,
      signal: new AbortController().signal,
    })
    expect(withStatementTimeout).toHaveBeenCalledTimes(1)
  })
})
