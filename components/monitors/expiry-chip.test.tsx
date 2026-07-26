import { describe, expect, it } from "vitest"

import { expirySentence, expiryWarnings } from "./expiry-chip"

const NOW = new Date("2026-07-23T12:00:00Z")

function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString()
}

describe("expiryWarnings", () => {
  it("returns every active warning soonest first", () => {
    const warnings = expiryWarnings(inDays(20), inDays(3), NOW)
    expect(warnings).toEqual([
      { kind: "domain", days: 3, level: "critical" },
      { kind: "cert", days: 20, level: "warning" },
    ])
  })

  it("is empty when facts are healthy or missing", () => {
    expect(expiryWarnings(inDays(45), null, NOW)).toEqual([])
    expect(expiryWarnings(null, null, NOW)).toEqual([])
    expect(expiryWarnings("not a date", null, NOW)).toEqual([])
  })

  it("keeps an overdue expiry as the most urgent", () => {
    const warnings = expiryWarnings(inDays(10), inDays(-2), NOW)
    expect(warnings[0]).toEqual({ kind: "domain", days: -2, level: "critical" })
  })
})

describe("expirySentence", () => {
  it("speaks direction and plurality", () => {
    expect(expirySentence({ kind: "domain", days: 1, level: "critical" })).toBe(
      "Domain expires in 1 day"
    )
    expect(expirySentence({ kind: "cert", days: 20, level: "warning" })).toBe(
      "Cert expires in 20 days"
    )
    expect(expirySentence({ kind: "domain", days: 0, level: "critical" })).toBe(
      "Domain expires today"
    )
    expect(expirySentence({ kind: "cert", days: -1, level: "critical" })).toBe(
      "Cert expired 1 day ago"
    )
    expect(
      expirySentence({ kind: "domain", days: -3, level: "critical" })
    ).toBe("Domain expired 3 days ago")
  })
})
