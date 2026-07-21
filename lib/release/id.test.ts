import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  getPulseReleaseId,
  isProductionRuntime,
  PULSE_RELEASE_ID_MAX_LENGTH,
  parseReleaseId,
  requirePulseReleaseId,
  resolveReleaseIdFromEnv,
} from "./id"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("parseReleaseId", () => {
  it("accepts a nonempty bounded id", () => {
    expect(parseReleaseId("dpl_abc123")).toEqual({
      ok: true,
      releaseId: "dpl_abc123",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(parseReleaseId("  dpl_trim  ")).toEqual({
      ok: true,
      releaseId: "dpl_trim",
    })
  })

  it("rejects missing, empty, and too-long values", () => {
    expect(parseReleaseId(undefined)).toEqual({ ok: false, reason: "missing" })
    expect(parseReleaseId(null)).toEqual({ ok: false, reason: "missing" })
    expect(parseReleaseId("")).toEqual({ ok: false, reason: "empty" })
    expect(parseReleaseId("   ")).toEqual({ ok: false, reason: "empty" })
    expect(parseReleaseId("x".repeat(PULSE_RELEASE_ID_MAX_LENGTH + 1))).toEqual(
      {
        ok: false,
        reason: "too_long",
      }
    )
  })

  it("accepts an id at the length bound", () => {
    const id = "x".repeat(PULSE_RELEASE_ID_MAX_LENGTH)
    expect(parseReleaseId(id)).toEqual({ ok: true, releaseId: id })
  })
})

describe("resolveReleaseIdFromEnv", () => {
  it("prefers explicit PULSE_RELEASE_ID over VERCEL_DEPLOYMENT_ID", () => {
    expect(
      resolveReleaseIdFromEnv({
        PULSE_RELEASE_ID: "explicit",
        VERCEL_DEPLOYMENT_ID: "vercel-dpl",
      })
    ).toEqual({ ok: true, releaseId: "explicit" })
  })

  it("falls back to VERCEL_DEPLOYMENT_ID when PULSE_RELEASE_ID is unset", () => {
    expect(
      resolveReleaseIdFromEnv({
        VERCEL_DEPLOYMENT_ID: "vercel-dpl",
      })
    ).toEqual({ ok: true, releaseId: "vercel-dpl" })
  })

  it("falls through an empty PULSE_RELEASE_ID placeholder to VERCEL_DEPLOYMENT_ID", () => {
    expect(
      resolveReleaseIdFromEnv({
        PULSE_RELEASE_ID: "",
        VERCEL_DEPLOYMENT_ID: "vercel-dpl",
      })
    ).toEqual({ ok: true, releaseId: "vercel-dpl" })
  })

  it("reports empty when only an empty PULSE_RELEASE_ID is set", () => {
    expect(
      resolveReleaseIdFromEnv({
        PULSE_RELEASE_ID: "",
      })
    ).toEqual({ ok: false, reason: "empty" })
  })

  it("reports missing when neither is set", () => {
    expect(resolveReleaseIdFromEnv({})).toEqual({
      ok: false,
      reason: "missing",
    })
  })
})

describe("isProductionRuntime", () => {
  it("treats VERCEL_ENV=production as production", () => {
    expect(isProductionRuntime({ VERCEL_ENV: "production" })).toBe(true)
  })

  it("treats preview and development as non-production", () => {
    expect(
      isProductionRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production" })
    ).toBe(false)
    expect(isProductionRuntime({ VERCEL_ENV: "development" })).toBe(false)
  })

  it("falls back to NODE_ENV when VERCEL_ENV is absent", () => {
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true)
    expect(isProductionRuntime({ NODE_ENV: "test" })).toBe(false)
  })
})

describe("getPulseReleaseId / requirePulseReleaseId", () => {
  it("returns null when invalid and throws from require", () => {
    expect(getPulseReleaseId({})).toBeNull()
    expect(() => requirePulseReleaseId({})).toThrow(
      /PULSE_RELEASE_ID is missing/
    )
  })

  it("returns the validated id when present", () => {
    expect(getPulseReleaseId({ PULSE_RELEASE_ID: "dpl_ok" })).toBe("dpl_ok")
    expect(requirePulseReleaseId({ PULSE_RELEASE_ID: "dpl_ok" })).toBe("dpl_ok")
  })

  it("fails closed for missing production release id", () => {
    // Mirrors the deploy-proof misconfigured path: production without identity.
    const env = { VERCEL_ENV: "production" }
    expect(isProductionRuntime(env)).toBe(true)
    expect(getPulseReleaseId(env)).toBeNull()
    expect(() => requirePulseReleaseId(env)).toThrow(
      /PULSE_RELEASE_ID is missing/
    )
  })
})
