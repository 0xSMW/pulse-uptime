import { afterEach, describe, expect, it, vi } from "vitest"

import { mutationOriginAllowed } from "./origin"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("mutation origin admission", () => {
  it("allows matching request origins during local development", () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    const request = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })

    expect(mutationOriginAllowed(request)).toBe(true)
  })

  it("fails closed in production when the canonical app URL is absent", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")

    const request = new Request(
      "https://attacker-controlled.example/api/auth/login",
      {
        method: "POST",
        headers: { origin: "https://attacker-controlled.example" },
      }
    )

    expect(mutationOriginAllowed(request)).toBe(false)
  })

  it("rejects an Origin containing URL components beyond the origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pulse.example")
    const request = new Request("https://pulse.example/api/auth/login", {
      method: "POST",
      headers: { origin: "https://pulse.example/unexpected-path" },
    })

    expect(mutationOriginAllowed(request)).toBe(false)
  })
})
