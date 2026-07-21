import { describe, expect, it } from "vitest"

import { safeReturnTo } from "./return-to"

describe("safeReturnTo", () => {
  it("preserves local paths and query parameters", () => {
    expect(safeReturnTo("/cli/authorize?user_code=PULSE-1234")).toBe(
      "/cli/authorize?user_code=PULSE-1234"
    )
  })

  it.each([
    "https://attacker.test/steal",
    "//attacker.test/steal",
    "/\\attacker.test/steal",
    "javascript:alert(1)",
  ])("rejects an unsafe target: %s", (target) => {
    expect(safeReturnTo(target)).toBe("/")
  })

  it("uses the supplied fallback for missing values", () => {
    expect(safeReturnTo(undefined, "/onboarding")).toBe("/onboarding")
  })
})
