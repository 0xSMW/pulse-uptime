import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createHttpChecker, runManualCheck } from "./checker"
import type {
  CheckerResponse,
  ManagedDispatcher,
  RequestExecutor,
} from "./types"

const secret = "private_monitor_test_key_0123456789abcdef"
const header = "x-pulse-monitor-key"
const target = {
  url: "https://example.com/health?probe=uptime",
  method: "GET" as const,
  timeoutMs: 8000,
  expectedStatus: { minimum: 200, maximum: 299 },
}

function response(statusCode = 200, location?: string): CheckerResponse {
  return {
    statusCode,
    headers: location ? { location } : {},
    body: { destroy: vi.fn() },
  }
}

function harness() {
  const request = vi.fn<RequestExecutor>().mockResolvedValue(response())
  const dependencies = {
    request,
    createDispatcher: () =>
      ({ close: async () => undefined }) as unknown as ManagedDispatcher,
  }
  return { request, dependencies, check: createHttpChecker(dependencies) }
}

describe("private monitor header", () => {
  beforeEach(() => {
    vi.stubEnv("PULSE_MONITOR_BYPASS_URL", target.url)
    vi.stubEnv("PULSE_MONITOR_BYPASS_SECRET", secret)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("adds the secret to the matching scheduled check without exposing it in results", async () => {
    const { request, check } = harness()
    const result = await check(target)

    expect(result).toMatchObject({ success: true, mode: "scheduled" })
    expect(request.mock.calls[0]?.[1].headers).toMatchObject({
      [header]: secret,
      "user-agent": "Pulse-Uptime/1.0",
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("uses the same private header policy for manual checks", async () => {
    const { request, dependencies } = harness()
    const result = await runManualCheck(target.url, {}, dependencies)

    expect(result).toMatchObject({ success: true, mode: "manual" })
    expect(request.mock.calls[0]?.[1].headers[header]).toBe(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("compares canonical URLs", async () => {
    vi.stubEnv(
      "PULSE_MONITOR_BYPASS_URL",
      "https://EXAMPLE.com:443/health?probe=uptime"
    )
    const { request, check } = harness()
    expect((await check(target)).success).toBe(true)
    expect(request.mock.calls[0]?.[1].headers[header]).toBe(secret)
  })

  it.each(["", undefined])(
    "leaves checks unchanged with disabled settings %s",
    async (value) => {
      vi.stubEnv("PULSE_MONITOR_BYPASS_URL", value)
      vi.stubEnv("PULSE_MONITOR_BYPASS_SECRET", value)
      const { request, check } = harness()

      expect((await check(target)).success).toBe(true)
      expect(request.mock.calls[0]?.[1].headers).toEqual({
        "user-agent": "Pulse-Uptime/1.0",
      })
    }
  )

  it.each([
    ["host", "https://other.example/health?probe=uptime", "GET"],
    ["path", "https://example.com/health/child?probe=uptime", "GET"],
    ["query", "https://example.com/health?probe=other", "GET"],
    ["missing query", "https://example.com/health", "GET"],
    ["HTTP", "http://example.com/health?probe=uptime", "GET"],
    ["HEAD", target.url, "HEAD"],
  ] as const)(
    "does not authorize a different %s",
    async (_name, url, method) => {
      const { request, check } = harness()
      const result = await check({ ...target, url, method })

      expect(result.success).toBe(true)
      expect(request).toHaveBeenCalledTimes(1)
      for (const [, options] of request.mock.calls) {
        expect(options.headers).not.toHaveProperty(header)
      }
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  )

  it.each([
    ["cross-origin", "https://other.example/next"],
    ["same-origin", "/next"],
    ["same-target", target.url],
  ])("strips the secret on a %s redirect", async (_name, location) => {
    const { request, check } = harness()
    request
      .mockResolvedValueOnce(response(302, location))
      .mockResolvedValueOnce(response())

    expect((await check(target)).success).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[1].headers[header]).toBe(secret)
    expect(request.mock.calls[1]?.[1].headers).not.toHaveProperty(header)
  })

  it("never restores the secret when a redirect returns to the target", async () => {
    const { request, check } = harness()
    request
      .mockResolvedValueOnce(response(302, "https://other.example/next"))
      .mockResolvedValueOnce(response(302, target.url))
      .mockResolvedValueOnce(response())

    expect((await check(target)).success).toBe(true)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[0]?.[1].headers[header]).toBe(secret)
    for (const [, options] of request.mock.calls.slice(1)) {
      expect(options.headers).not.toHaveProperty(header)
    }
  })

  it("does not authorize a redirect into the configured target", async () => {
    const { request, check } = harness()
    request
      .mockResolvedValueOnce(response(302, target.url))
      .mockResolvedValueOnce(response())

    expect(
      (await check({ ...target, url: "https://other.example/start" })).success
    ).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    for (const [, options] of request.mock.calls) {
      expect(options.headers).not.toHaveProperty(header)
    }
  })

  it.each([
    ["missing URL", "", secret],
    ["missing secret", target.url, ""],
    ["HTTP target", "http://example.com/health", secret],
    ["credentials", "https://user:password@example.com/health", secret],
    ["fragment", `${target.url}#fragment`, secret],
    ["empty fragment", `${target.url}#`, secret],
    ["short secret", target.url, "too_short"],
    ["invalid secret", target.url, `${secret}\r\ninjected: value`],
    ["long secret", target.url, "a".repeat(257)],
  ])(
    "fails closed for %s without exposing configuration",
    async (_name, url, value) => {
      vi.stubEnv("PULSE_MONITOR_BYPASS_URL", url)
      vi.stubEnv("PULSE_MONITOR_BYPASS_SECRET", value)
      const { request, check } = harness()
      const result = await check(target)

      expect(result).toMatchObject({ success: false, errorCode: "UNKNOWN" })
      expect(request).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(result.errorMessage).not.toContain("password")
      expect(result.errorMessage).not.toContain("injected")
      if (value) {
        expect(JSON.stringify(result)).not.toContain(value)
      }
    }
  )

  it("does not expose the secret in request error results", async () => {
    const { request, check } = harness()
    request.mockRejectedValueOnce(new Error(`request rejected ${secret}`))
    const result = await check(target)

    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("rejects a disallowed port before sending any request", async () => {
    const { request, check } = harness()
    const result = await check({
      ...target,
      url: "https://example.com:444/health?probe=uptime",
    })

    expect(result).toMatchObject({ success: false, errorCode: "INVALID_URL" })
    expect(request).not.toHaveBeenCalled()
  })
})
