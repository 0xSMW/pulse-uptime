// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({
  push: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: router.push,
    prefetch: router.prefetch,
    refresh: router.refresh,
  }),
}))
vi.mock("@/components/charts/lazy-latency-chart", () => ({
  LazyLatencyChart: () => null,
}))
vi.mock("./use-monitor-live", () => ({
  useMonitorLive: () => ({
    data: null,
    updatedAt: null,
    isPaused: false,
    isStale: false,
  }),
}))

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import {
  domainExpiryLine,
  MonitorDetail,
  type MonitorDetailData,
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

const emptyRanges = { h24: null, d7: null, d30: null, d90: null }
const emptyAvailability = { start: "2026-11-13T00:00:00.000Z", buckets: [] }

function detailMonitor(
  overrides: Partial<MonitorDetailData> = {}
): MonitorDetailData {
  return {
    id: "api-prod",
    name: "API Production",
    url: "https://api.example.com/health",
    method: "GET",
    groupId: null,
    group: null,
    enabled: true,
    intervalMinutes: 1,
    timeoutMs: 8000,
    recipients: [],
    state: "UP",
    intervalSeconds: 60,
    timeoutSeconds: 8,
    expectedStatusMin: 200,
    expectedStatusMax: 399,
    failureThreshold: 2,
    recoveryThreshold: 2,
    recipientCount: 0,
    expectedText: null,
    domainHealth: {
      apexDomain: "example.com",
      certExpiresAt: "2027-06-01T00:00:00.000Z",
      certIssuer: "Example CA",
      domainExpiresAt: "2027-08-01T00:00:00.000Z",
      domainRegistrar: "Porkbun LLC",
      registrationSource: "porkbun",
      domainAutoRenew: true,
    },
    latestLatencyMs: 120,
    lastCheckedAt: "2026-11-13T09:00:00.000Z",
    p95LatencyMs: 200,
    uptime: { h24: 1, d7: 1, d30: 1, d90: 1 },
    coverage: { h24: 1, d7: 1, d30: 1, d90: 1 },
    rangeUnlocked: { h24: true, d7: true, d30: true, d90: true },
    firstRun: {
      phase: "active",
      activatedAt: "2026-10-01T00:00:00.000Z",
      observedSeconds: 0,
      observed: { uptime: null, completed: 0, expected: 0 },
      setupError: null,
      lastCheckedAt: "2026-11-13T09:00:00.000Z",
    },
    availability: {
      h24: emptyAvailability,
      d7: emptyAvailability,
      d30: emptyAvailability,
      d90: emptyAvailability,
    },
    responseTime: { h24: [], d7: [], d30: [] },
    latestIncident: null,
    recentIncidents: [],
    recentChecks: [],
    rollupVersion: null,
    acceptedConfigToken: null,
    windowVersion: "v1",
    ...overrides,
  }
}

function renderDetail(
  monitor: MonitorDetailData,
  canManageMonitors = true
): ReturnType<typeof render> {
  return render(
    <TimezoneProvider>
      <MonitorDetail
        canManageMonitors={canManageMonitors}
        groups={[]}
        monitor={monitor}
      />
    </TimezoneProvider>
  )
}

function latestIncident(
  overrides: Partial<NonNullable<MonitorDetailData["latestIncident"]>>
): NonNullable<MonitorDetailData["latestIncident"]> {
  return {
    id: "inc-1",
    state: "RESOLVED",
    openedAt: "2026-11-13T08:00:00.000Z",
    resolvedAt: "2026-11-13T08:05:00.000Z",
    durationSeconds: 300,
    openingFailure: "HTTP 503",
    exclusionStatus: null,
    overlaps: [],
    ...overrides,
  }
}

function incidentBanner(): HTMLElement {
  return screen.getByText("HTTP 503").closest("a")!
}

describe("MonitorDetail latest incident banner", () => {
  it("shows one green False alarm badge first for a resolved false alarm", () => {
    renderDetail(
      detailMonitor({
        latestIncident: latestIncident({ exclusionStatus: "full" }),
      })
    )
    const banner = incidentBanner()
    const badges = within(banner).getAllByText("False alarm")
    expect(badges).toHaveLength(1)
    const badge = badges[0]!
    expect(badge.className).toContain("bg-[var(--up-bg)]")
    expect(within(banner).queryByText("Recently resolved")).toBeNull()
    // The badge's own dot is the only dot in the label group
    const group = badge.parentElement!
    expect(group.querySelectorAll(".rounded-full")).toHaveLength(2)
    expect(group.firstElementChild).toBe(badge)
    expect(
      badge.compareDocumentPosition(within(banner).getByText("HTTP 503")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("keeps Recently resolved for a normal resolved incident", () => {
    renderDetail(detailMonitor({ latestIncident: latestIncident({}) }))
    const banner = incidentBanner()
    expect(within(banner).getByText("Recently resolved")).toBeDefined()
    expect(within(banner).queryByText("False alarm")).toBeNull()
  })

  it("keeps Ongoing incident with the badge for a fully excluded ongoing incident", () => {
    renderDetail(
      detailMonitor({
        latestIncident: latestIncident({
          state: "ONGOING",
          resolvedAt: null,
          exclusionStatus: "full",
        }),
      })
    )
    const banner = incidentBanner()
    expect(within(banner).getByText("Ongoing incident")).toBeDefined()
    expect(within(banner).getByText("False alarm")).toBeDefined()
  })

  it("keeps Recently resolved with the partial annotation", () => {
    renderDetail(
      detailMonitor({
        latestIncident: latestIncident({ exclusionStatus: "partial" }),
      })
    )
    const banner = incidentBanner()
    expect(within(banner).getByText("Recently resolved")).toBeDefined()
    expect(within(banner).getByText("Partially excluded")).toBeDefined()
  })
})

function setupMonitor(setupError: string | null): MonitorDetailData {
  return detailMonitor({
    state: "PENDING",
    uptime: emptyRanges,
    coverage: emptyRanges,
    rangeUnlocked: { h24: false, d7: false, d30: false, d90: false },
    firstRun: {
      phase: "setup",
      activatedAt: null,
      observedSeconds: 0,
      observed: { uptime: null, completed: 0, expected: 0 },
      setupError,
      lastCheckedAt: null,
    },
  })
}

describe("MonitorDetail setup phase", () => {
  it("shows the setup rule once and no second card without an error", () => {
    renderDetail(setupMonitor(null))
    expect(screen.getAllByText("Verifying setup")).toHaveLength(1)
    expect(
      screen.getAllByText("Monitoring begins at the first successful check")
    ).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Run Test" })).toBeNull()
  })

  it("shows one failure line with its actions when setup fails", () => {
    renderDetail(setupMonitor("HTTP 503"))
    expect(screen.getAllByText("Verifying setup")).toHaveLength(1)
    const line = screen.getByText("Last check failed with HTTP 503")
    expect(line.classList.contains("sr-only")).toBe(false)
    const card = line.parentElement!
    expect(within(card).getByRole("button", { name: "Run Test" })).toBeDefined()
    expect(
      within(card).getByRole("button", { name: "Edit Monitor" })
    ).toBeDefined()
    expect(card.textContent).not.toContain("incidents")
  })

  it("keeps the failure line for viewers without actions", () => {
    renderDetail(setupMonitor("TIMEOUT"), false)
    expect(screen.getByText("Last check failed with TIMEOUT")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Run Test" })).toBeNull()
  })
})

describe("MonitorDetail domain and certificate card", () => {
  it("keeps registrar and expiry facts without a Verified source row", () => {
    renderDetail(detailMonitor())
    const card = screen
      .getByText("Domain & Certificate")
      .closest("#domain-certificate") as HTMLElement
    expect(within(card).getByText("Registrar")).toBeDefined()
    expect(within(card).getByText("Porkbun")).toBeDefined()
    expect(within(card).getByText("Certificate expires")).toBeDefined()
    expect(within(card).getByText("Domain expires")).toBeDefined()
    expect(within(card).getByText("Issued by")).toBeDefined()
    expect(within(card).queryByText("Verified")).toBeNull()
    expect(card.textContent).not.toContain("direct TLS")
  })
})
