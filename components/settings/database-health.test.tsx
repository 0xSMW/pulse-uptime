// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import type { DatabaseHealth } from "@/lib/database-health/types"
import {
  DatabaseHealthCard,
  formatDatabaseBytes,
  formatRetention,
} from "./database-health"

const report: DatabaseHealth = {
  health: "HEALTHY",
  summary: "Storage remains within its configured budget",
  budgetBytes: 500_000_000,
  usedBytes: 118_000_000,
  availableBytes: 382_000_000,
  projected30DayBytes: 146_000_000,
  categories: [
    { key: "rollups", label: "Rollups", bytes: 62_000_000 },
    { key: "other", label: "Other", bytes: 4_000_000 },
  ],
  retention: [
    {
      key: "recent",
      label: "Recent checks",
      configuredSeconds: 172_800,
      oldestAt: "2026-07-17T05:00:00.000Z",
    },
  ],
  governor: {
    mode: "FULL_DETAIL",
    action: "Keeping full configured detail",
    lastCompactionAt: "2026-07-18T03:17:00.000Z",
  },
  schedulerCoverage: 0.9999,
  transfer: {
    usedBytes: 420_000_000,
    budgetBytes: 5_000_000_000,
    projectedBytes: 690_000_000,
  },
  freshness: {
    capturedAt: "2026-07-18T11:55:00.000Z",
    ageSeconds: 300,
    stale: false,
    providerMetricsAvailable: true,
    providerCapturedAt: "2026-07-18T11:54:00.000Z",
    providerAgeSeconds: 360,
  },
  maintenanceHealthy: true,
  refresh: {
    cached: false,
    status: "CURRENT",
    nextEligibleAt: "2026-07-18T12:10:00.000Z",
  },
}

describe("DatabaseHealthCard", () => {
  it("renders budget, attribution, retention, management, transfer, and freshness", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <DatabaseHealthCard initialData={report} />
      </TimezoneProvider>
    )
    expect(html).toContain("Healthy")
    expect(html).toContain("118 MB of 500 MB")
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="24"')
    expect(html).toContain("Other")
    expect(html).toContain("Recent checks")
    expect(html).toContain("Keeping full configured detail")
    expect(html).toContain("99.99%")
    expect(html).toContain("Projected this month")
    expect(html).toContain("Updated Jul 18")
  })

  it("renders a contained empty state", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <DatabaseHealthCard initialData={null} />
      </TimezoneProvider>
    )
    expect(html).toContain("No usage snapshot yet")
    expect(html).toContain(">Refresh</button>")
  })

  it("distinguishes a failed read from an empty database", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <DatabaseHealthCard initialData={null} initialError />
      </TimezoneProvider>
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Database health unavailable")
    expect(html).not.toContain("No usage snapshot yet")
  })

  it("keeps partial relation data and marks unknown usage as indeterminate", () => {
    const partial: DatabaseHealth = {
      ...report,
      health: "UNKNOWN",
      usedBytes: null,
      availableBytes: null,
      freshness: {
        ...report.freshness,
        providerMetricsAvailable: false,
        providerCapturedAt: null,
        providerAgeSeconds: null,
      },
    }
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <DatabaseHealthCard initialData={partial} />
      </TimezoneProvider>
    )
    expect(html).toContain(
      "Provider transfer metrics are not collected on this deployment, relation usage remains current"
    )
    expect(html).toContain('aria-valuetext="Storage usage unavailable"')
    expect(html).not.toContain("aria-valuenow")
    expect(html).toContain("Rollups")
  })
})

describe("DatabaseHealthCard refresh", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function refreshWith(response: Response) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    render(
      <TimezoneProvider>
        <DatabaseHealthCard initialData={report} />
      </TimezoneProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    })
  }

  it("shows no message after a fresh measurement", async () => {
    await refreshWith(
      Response.json({
        data: {
          ...report,
          freshness: {
            ...report.freshness,
            capturedAt: "2026-07-19T08:00:00.000Z",
          },
        },
      })
    )
    expect(screen.queryByText("Database metrics refreshed")).toBeNull()
    expect(screen.getByText(/^Updated Jul 19/)).toBeDefined()
  })

  it("keeps the stale fallback visible", async () => {
    await refreshWith(
      Response.json({
        data: {
          ...report,
          refresh: { ...report.refresh, status: "STALE_FALLBACK" },
        },
      })
    )
    const message = screen.getByText(
      "Refresh failed, showing the last measurement"
    )
    expect(message.classList.contains("sr-only")).toBe(false)
  })

  it("keeps a failed refresh visible", async () => {
    await refreshWith(
      Response.json(
        { error: { message: "Database health is unavailable" } },
        { status: 503 }
      )
    )
    const message = screen.getByText("Database health is unavailable")
    expect(message.classList.contains("sr-only")).toBe(false)
  })
})

describe("database health formatting", () => {
  it("uses decimal byte units and pithy retention ages", () => {
    expect(formatDatabaseBytes(500_000_000)).toBe("500 MB")
    expect(formatDatabaseBytes(null)).toBe("Unavailable")
    expect(formatRetention(172_800)).toBe("2 days")
  })
})
