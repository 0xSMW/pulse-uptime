import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { CheckResult } from "@/lib/checker"

import {
  deriveMonitorName,
  isSecurityFailure,
  monitorIdFor,
  validateDraft,
} from "./service"

function failure(
  errorCode: "BLOCKED_TARGET" | "TIMEOUT" | "INVALID_REDIRECT"
): CheckResult {
  return {
    mode: "manual",
    method: "GET",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    hostname: "example.com",
    resolvedAddress: null,
    statusCode: null,
    latencyMs: 10,
    redirectCount: 0,
    success: false,
    errorCode,
    errorMessage: "failed",
  }
}

describe("onboarding monitor service", () => {
  it("derives editable names and stable valid slugs", () => {
    expect(deriveMonitorName("https://www.example.com/health")).toBe(
      "example.com"
    )
    expect(monitorIdFor("My Main Site", "https://example.com")).toBe(
      "my-main-site"
    )
  })

  it("normalizes and preserves a public monitor draft", () => {
    expect(
      validateDraft({ url: "https://example.com", name: " Main Site " })
    ).toEqual({
      url: "https://example.com/",
      name: "Main Site",
      alertEmail: undefined,
    })
  })

  it("blocks security failures while allowing availability overrides", () => {
    expect(isSecurityFailure(failure("BLOCKED_TARGET"))).toBe(true)
    expect(isSecurityFailure(failure("INVALID_REDIRECT"))).toBe(true)
    expect(isSecurityFailure(failure("TIMEOUT"))).toBe(false)
  })
})
