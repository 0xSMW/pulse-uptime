import { describe, expect, it } from "vitest"

import { domainExpiryLine, domainVerificationCopy } from "./monitor-detail"

const expiry = "2027-01-02T03:04:05.000Z"
const now = new Date("2026-12-20T00:00:00.000Z")

describe("domainExpiryLine", () => {
  it("uses expiry wording and Porkbun auto-renew facts without promising a charge date", () => {
    const line = domainExpiryLine(
      {
        apexDomain: "example.com",
        certExpiresAt: null,
        certIssuer: null,
        domainExpiresAt: expiry,
        domainRegistrar: "Porkbun LLC",
        registrationSource: "porkbun",
        domainAutoRenew: true,
      },
      "UTC",
      now
    )

    expect(line).toContain("Expires")
    expect(line).toContain("Porkbun")
    expect(line).toContain("Auto-renew on")
    expect(line).not.toContain("Renews")
    expect(line).not.toContain("charge")
  })

  it("omits auto-renew when only RDAP supplied the domain facts", () => {
    const line = domainExpiryLine(
      {
        apexDomain: "example.com",
        certExpiresAt: null,
        certIssuer: null,
        domainExpiresAt: expiry,
        domainRegistrar: "Example Registrar",
        registrationSource: "rdap",
        domainAutoRenew: null,
      },
      "UTC",
      now
    )

    expect(line).toContain("Example Registrar")
    expect(line).not.toContain("Auto-renew")
  })

  it("returns null without an expiry fact", () => {
    expect(
      domainExpiryLine(
        {
          apexDomain: "example.com",
          certExpiresAt: null,
          certIssuer: null,
          domainExpiresAt: null,
          domainRegistrar: "Porkbun",
          registrationSource: "porkbun",
          domainAutoRenew: false,
        },
        "UTC",
        now
      )
    ).toBeNull()
  })
})

describe("domainVerificationCopy", () => {
  it("names Porkbun when it supplied registration facts", () => {
    expect(domainVerificationCopy("porkbun")).toBe(
      "Domains via Porkbun, certificates via direct TLS"
    )
  })

  it("names RDAP when it supplied registration facts", () => {
    expect(domainVerificationCopy("rdap")).toBe(
      "Domains via RDAP, certificates via direct TLS"
    )
  })

  it("does not claim a domain source when registration facts are absent", () => {
    expect(domainVerificationCopy(null)).toBe("Certificates via direct TLS")
  })
})
