// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}))

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import {
  type DashboardMonitor,
  HOVER_PREFETCH_DELAY_MS,
  isPlainLeftClick,
  MonitorTable,
  navigateFromMonitorRow,
  shouldPrefetchMonitor,
} from "./monitor-table"

afterEach(() => {
  cleanup()
})

function monitor(
  state: DashboardMonitor["state"],
  overrides: Partial<DashboardMonitor> = {}
): DashboardMonitor {
  return {
    id: `mon-${state}`,
    name: `Monitor ${state}`,
    url: `https://${state.toLowerCase()}.example.com/health`,
    state,
    uptime24h: null,
    latestLatencyMs: null,
    lastCheckedAt: null,
    activatedAt: null,
    activeIncidentOpenedAt: null,
    uptime24hUnlocked: false,
    timeline: [],
    certExpiresAt: null,
    domainExpiresAt: null,
    ...overrides,
  }
}

function statusCell(name: string): string | null | undefined {
  return screen.getByRole("link", { name }).closest("tr")?.cells[0]?.textContent
}

describe("MonitorTable", () => {
  it("uses the shared state labels and keeps setup apart from confirmation", () => {
    render(
      <TimezoneProvider>
        <MonitorTable
          monitors={[
            monitor("PENDING"),
            monitor("VERIFYING_DOWN"),
            monitor("VERIFYING_UP"),
            monitor("PAUSED"),
          ]}
        />
      </TimezoneProvider>
    )
    expect(statusCell("Monitor PENDING")).toBe("Pending")
    expect(statusCell("Monitor VERIFYING_DOWN")).toBe("Verifying")
    expect(statusCell("Monitor VERIFYING_UP")).toBe("Verifying")
    expect(statusCell("Monitor PAUSED")).toBe("Paused")
    expect(document.body.textContent).not.toContain("Verifying Down")
  })

  it("wraps long monitor names and URLs instead of truncating them", () => {
    const name = `Checkout ${"service".repeat(20)}`
    const url = `https://example.com/${"path".repeat(40)}`
    render(
      <TimezoneProvider>
        <MonitorTable monitors={[monitor("UP", { name, url })]} />
      </TimezoneProvider>
    )
    expect(screen.getByRole("link", { name }).className).not.toContain(
      "truncate"
    )
    expect(screen.getByText(url).className).not.toContain("truncate")
  })
})

function targetWithClosest(result: Element | null): EventTarget {
  return { closest: vi.fn(() => result) } as unknown as EventTarget
}

describe("navigateFromMonitorRow", () => {
  it("navigates non-interactive row clicks to the encoded detail route", () => {
    const navigate = vi.fn()

    const handled = navigateFromMonitorRow(
      targetWithClosest(null),
      "public api",
      navigate
    )

    expect(handled).toBe(true)
    expect(navigate).toHaveBeenCalledWith("/monitors/public%20api")
  })

  it("does not hijack nested interactive controls", () => {
    const navigate = vi.fn()

    const handled = navigateFromMonitorRow(
      targetWithClosest({} as Element),
      "public-api",
      navigate
    )

    expect(handled).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("isPlainLeftClick", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  }

  it("accepts an unmodified left click", () => {
    expect(isPlainLeftClick(plain)).toBe(true)
  })

  it.each([
    ["middle button", { ...plain, button: 1 }],
    ["cmd", { ...plain, metaKey: true }],
    ["ctrl", { ...plain, ctrlKey: true }],
    ["shift", { ...plain, shiftKey: true }],
    ["alt", { ...plain, altKey: true }],
    ["defaultPrevented", { ...plain, defaultPrevented: true }],
  ])(
    "rejects %s clicks so they never enter the pending state",
    (_label, event) => {
      expect(isPlainLeftClick(event)).toBe(false)
    }
  )
})

describe("shouldPrefetchMonitor", () => {
  it("allows the first prefetch for a monitor id and records it", () => {
    const prefetched = new Set<string>()

    const allowed = shouldPrefetchMonitor("mon-1", prefetched)

    expect(allowed).toBe(true)
    expect(prefetched.has("mon-1")).toBe(true)
  })

  it("skips repeat prefetches for an id already seen this lifetime", () => {
    const prefetched = new Set<string>(["mon-1"])

    const allowed = shouldPrefetchMonitor("mon-1", prefetched)

    expect(allowed).toBe(false)
    expect(prefetched.size).toBe(1)
  })

  it("tracks multiple ids independently", () => {
    const prefetched = new Set<string>()

    expect(shouldPrefetchMonitor("mon-1", prefetched)).toBe(true)
    expect(shouldPrefetchMonitor("mon-2", prefetched)).toBe(true)
    expect(shouldPrefetchMonitor("mon-1", prefetched)).toBe(false)
    expect(prefetched).toEqual(new Set(["mon-1", "mon-2"]))
  })
})

describe("HOVER_PREFETCH_DELAY_MS", () => {
  it("is a short, non-zero hover-intent delay", () => {
    expect(HOVER_PREFETCH_DELAY_MS).toBeGreaterThan(0)
    expect(HOVER_PREFETCH_DELAY_MS).toBeLessThanOrEqual(250)
  })
})
