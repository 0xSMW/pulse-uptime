import { describe, expect, it } from "vitest"

import { apexDomain } from "./apex"
import { daysUntil, expiryLevel } from "./expiry"

const now = new Date("2026-07-22T00:00:00Z")
const days = (count: number) => new Date(now.getTime() + count * 86_400_000)

describe("expiryLevel", () => {
  it("is ok at or beyond 30 days", () => {
    expect(expiryLevel(days(30), now)).toBe("ok")
    expect(expiryLevel(days(400), now)).toBe("ok")
  })

  it("warns under 30 days and turns critical under 14", () => {
    expect(expiryLevel(days(29), now)).toBe("warning")
    expect(expiryLevel(days(14), now)).toBe("warning")
    expect(expiryLevel(days(13), now)).toBe("critical")
    expect(expiryLevel(days(0), now)).toBe("critical")
    expect(expiryLevel(days(-5), now)).toBe("critical")
  })
})

describe("daysUntil", () => {
  it("floors partial days and goes negative after expiry", () => {
    expect(daysUntil(new Date(now.getTime() + 36 * 3_600_000), now)).toBe(1)
    expect(daysUntil(days(-2), now)).toBe(-2)
  })
})

describe("apexDomain", () => {
  it("reduces hostnames to their registrable apex", () => {
    expect(apexDomain("admin.gxd.io")).toBe("gxd.io")
    expect(apexDomain("app.klu.ai")).toBe("klu.ai")
    expect(apexDomain("example.com")).toBe("example.com")
    expect(apexDomain("service.gov.uk")).toBe("service.gov.uk")
  })

  it("returns null for IP literals and bare public suffixes", () => {
    expect(apexDomain("203.0.113.7")).toBeNull()
    expect(apexDomain("co.uk")).toBeNull()
    expect(apexDomain("localhost")).toBeNull()
  })
})
