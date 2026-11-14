// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: router.push, prefetch: router.prefetch }),
}))

import {
  domainExpiryLine,
  domainVerificationCopy,
  RecentIncidentsTable,
} from "./monitor-detail"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const longFailure = `TLS handshake failed ${"x".repeat(120)}`

function renderRecentIncidents() {
  return render(
    <RecentIncidentsTable
      incidents={[
        {
          id: "inc 1",
          openedAt: "2026-11-13T09:00:00.000Z",
          durationSeconds: 300,
          openingFailure: longFailure,
          exclusionStatus: "full",
        },
      ]}
      mounted={false}
      timeZone="UTC"
    />
  )
}

describe("RecentIncidentsTable", () => {
  it("navigates the whole row on a plain left click", () => {
    renderRecentIncidents()
    const row = screen.getByText(longFailure).closest("tr")!
    expect(row.className).toContain("cursor-pointer")
    fireEvent.click(row.cells[1]!, { button: 0 })
    expect(router.push).toHaveBeenCalledWith("/incidents/inc%201")
  })

  it.each([
    ["cmd", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["middle button", { button: 1 }],
  ])("leaves %s clicks to the browser", (_label, modifier) => {
    renderRecentIncidents()
    const row = screen.getByText(longFailure).closest("tr")!
    fireEvent.click(row.cells[1]!, { button: 0, ...modifier })
    expect(router.push).not.toHaveBeenCalled()
  })

  it("keeps the Started link a real anchor and leaves its click alone", () => {
    renderRecentIncidents()
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("/incidents/inc%201")
    fireEvent.click(link, { button: 0 })
    expect(router.push).not.toHaveBeenCalled()
  })

  it("wraps the opening failure and keeps the exclusion badge as a sibling", () => {
    renderRecentIncidents()
    const failure = screen.getByText(longFailure)
    const badge = screen.getByText("False alarm")
    expect(failure.contains(badge)).toBe(false)
    expect(failure.parentElement).toBe(badge.parentElement)
    expect(failure.parentElement?.className).toContain("flex-wrap")
    expect(failure.closest("td")?.className).not.toContain("truncate")
  })

  it("renders the False alarm badge in the up green with a dot", () => {
    renderRecentIncidents()
    const badge = screen.getByText("False alarm")
    expect(badge.className).toContain("bg-[var(--up-bg)]")
    expect(badge.className).toContain("text-[var(--up-text)]")
    expect(badge.querySelector(".bg-\\[var\\(--up\\)\\]")).toBeTruthy()
  })
})

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
