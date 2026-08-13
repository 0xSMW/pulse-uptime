import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { createLocalAdmissionControl } from "./local-admission"

describe("local admission control", () => {
  let admission: ReturnType<typeof createLocalAdmissionControl>

  beforeEach(() => {
    admission = createLocalAdmissionControl({
      limit: 2,
      maxEntries: 2,
      windowMs: 1000,
    })
  })

  it("admits up to the limit and resets after the fixed window", () => {
    expect(admission.check("one", 1000).allowed).toBe(true)
    expect(admission.check("one", 1001).allowed).toBe(true)
    expect(admission.check("one", 1002)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    })
    expect(admission.check("one", 2000).allowed).toBe(true)
  })

  it("keeps attacker-controlled source cardinality bounded", () => {
    admission.check("one", 1000)
    admission.check("two", 1000)
    expect(admission.check("three", 1000).allowed).toBe(true)
    expect(admission.check("one", 1000).allowed).toBe(true)
  })
})
