import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { AuthServiceError } from "@/lib/auth/service"

import { loginFailure } from "./route"

describe("login route failures", () => {
  it("returns generic 429 copy and Retry-After when limited", async () => {
    const response = loginFailure(
      new AuthServiceError("RATE_LIMITED", "Sign in failed", 37)
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("37")
    await expect(response.json()).resolves.toEqual({ error: "Sign in failed" })
  })

  it("preserves generic 401 responses for invalid credentials", async () => {
    const response = loginFailure(
      new AuthServiceError("INVALID_LOGIN", "Sign in failed")
    )
    expect(response.status).toBe(401)
    expect(response.headers.get("Retry-After")).toBeNull()
    await expect(response.json()).resolves.toEqual({ error: "Sign in failed" })
  })
})
