// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), prefetch: vi.fn() }),
}))

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import { IncidentHistoryTable } from "./incident-history-table"
import type { IncidentSummary } from "./types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const incident: IncidentSummary = {
  id: "inc-1",
  monitorId: "mon-1",
  monitorName: "API Production",
  openedAt: "2026-07-18T09:00:00.000Z",
  resolvedAt: "2026-07-18T09:30:00.000Z",
  durationSeconds: 1800,
  openingFailure: "HTTP 503",
  notificationSummary: { state: "sent", sentCount: 1 },
}

function renderTable(canWriteReports = true) {
  return render(
    <TimezoneProvider>
      <IncidentHistoryTable
        canWriteReports={canWriteReports}
        incidents={[incident]}
      />
    </TimezoneProvider>
  )
}

describe("IncidentHistoryTable", () => {
  it("names the section History for screen readers without a visible heading", () => {
    renderTable()
    const heading = screen.getByRole("heading", { name: "History" })
    expect(heading.classList.contains("sr-only")).toBe(true)
    expect(heading.className).not.toContain("mb-3")
    expect(screen.getByRole("region", { name: "History" })).toBeDefined()
  })

  it("navigates the whole row to the incident on a plain left click", () => {
    renderTable()
    const link = screen.getByRole("link", { name: "API Production" })
    expect(link.getAttribute("href")).toBe("/incidents/inc-1")
    const row = link.closest("tr")!
    expect(row.className).toContain("cursor-pointer")
    fireEvent.click(row, { button: 0 })
    expect(push).toHaveBeenCalledWith("/incidents/inc-1")
  })

  it("leaves clicks on the row's Write Report button to the button (finding: a naive row click would hijack inner controls)", () => {
    renderTable()
    const button = screen.getByRole("button", { name: "Write Report" })
    fireEvent.click(button, { button: 0 })
    expect(push).not.toHaveBeenCalledWith("/incidents/inc-1")
  })

  it("hides Write Report and its column from viewers", () => {
    renderTable(false)
    expect(screen.queryByRole("button", { name: "Write Report" })).toBeNull()
    expect(screen.queryByText("Actions")).toBeNull()
    expect(screen.getByRole("link", { name: "API Production" })).toBeTruthy()
  })

  function renderState(overrides: Partial<IncidentSummary>) {
    render(
      <TimezoneProvider>
        <IncidentHistoryTable
          canWriteReports
          incidents={[{ ...incident, ...overrides }]}
        />
      </TimezoneProvider>
    )
    return screen.getByRole("link", { name: "API Production" }).closest("tr")!
      .cells[1]!
  }

  it("shows one green False alarm badge and no Resolved badge for a fully excluded resolved incident", () => {
    const cell = renderState({ exclusionStatus: "full" })
    const badge = screen.getByText("False alarm")
    expect(cell.textContent).toBe("False alarm")
    expect(screen.queryByText("Resolved", { selector: "span" })).toBeNull()
    expect(badge.className).toContain("bg-[var(--up-bg)]")
    expect(badge.className).toContain("text-[var(--up-text)]")
    expect(badge.querySelector(".bg-\\[var\\(--up\\)\\]")).toBeTruthy()
    expect(screen.getByText("HTTP 503")).toBeTruthy()
  })

  it("keeps the Resolved badge alone for a normal resolved incident", () => {
    const cell = renderState({})
    expect(cell.textContent).toBe("Resolved")
    expect(screen.queryByText("False alarm")).toBeNull()
  })

  it("keeps Resolved with the partial annotation for a partially excluded incident", () => {
    const cell = renderState({ exclusionStatus: "partial" })
    expect(cell.textContent).toBe("ResolvedPartially excluded")
  })

  it("keeps an ongoing incident visibly Ongoing even when fully excluded", () => {
    const cell = renderState({ resolvedAt: null, exclusionStatus: "full" })
    expect(screen.getByText("Ongoing", { selector: "span" })).toBeTruthy()
    expect(cell.textContent).toBe("OngoingFalse alarm")
  })

  it("does not render a Status column (finding: it duplicated the HTTP code already shown by Opening Failure)", () => {
    renderTable()
    const headers = screen
      .getAllByRole("columnheader")
      .map((th) => th.textContent)
    expect(headers).toContain("Opening Failure")
    expect(headers).not.toContain("Status")
    expect(screen.getByText("HTTP 503")).toBeTruthy()
    expect(screen.queryByText("resolved")).toBeNull()
  })
})
