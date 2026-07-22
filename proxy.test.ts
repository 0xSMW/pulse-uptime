import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { proxy } from "./proxy"

describe("status page proxy", () => {
  it("sets a fresh strict CSP for status page rendering", () => {
    const first = proxy(new NextRequest("https://pulse.test/status"))
    const second = proxy(new NextRequest("https://pulse.test/status/group"))
    const firstPolicy = first.headers.get("Content-Security-Policy")
    const secondPolicy = second.headers.get("Content-Security-Policy")

    expect(firstPolicy).toContain("script-src 'self' 'nonce-")
    expect(firstPolicy).toContain("'strict-dynamic'")
    expect(firstPolicy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(secondPolicy).not.toBe(firstPolicy)
  })
})
