import { describe, expect, it } from "vitest"

import { buildStatusPageContentSecurityPolicy } from "./csp"

describe("status page Content Security Policy", () => {
  it("allows only nonce-bearing production scripts", () => {
    const policy = buildStatusPageContentSecurityPolicy("nonce123", false)

    expect(policy).toContain(
      "script-src 'self' 'nonce-nonce123' 'strict-dynamic'"
    )
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).toContain(
      "connect-src 'self' https://www.google-analytics.com"
    )
    expect(policy).toContain("object-src 'none'")
  })

  it("permits the development evaluator without weakening inline scripts", () => {
    const policy = buildStatusPageContentSecurityPolicy("devnonce", true)

    expect(policy).toContain(
      "script-src 'self' 'nonce-devnonce' 'strict-dynamic' 'unsafe-eval'"
    )
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})
