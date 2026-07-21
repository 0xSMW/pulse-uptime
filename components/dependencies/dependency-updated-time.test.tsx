// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import {
  DependencyFidelityBadge,
  DependencyStatusBadge,
  INCIDENT_FEED_ONLY_LABEL,
} from "./dependency-status"
import { DependencyUpdatedTime } from "./dependency-updated-time"

afterEach(() => {
  cleanup()
})

function renderWithTimezone(node: ReactNode) {
  return render(<TimezoneProvider>{node}</TimezoneProvider>)
}

describe("DependencyUpdatedTime", () => {
  it("reads 'Awaiting first check' while the first poll is pending", () => {
    renderWithTimezone(<DependencyUpdatedTime pending value={null} />)
    expect(screen.getByText("Awaiting first check")).toBeDefined()
  })

  it("keeps 'Never' when a poll has landed but the provider reported no update time", () => {
    renderWithTimezone(<DependencyUpdatedTime pending={false} value={null} />)
    expect(screen.getByText("Never")).toBeDefined()
  })

  it("prefers the pending copy over any stale timestamp value", () => {
    renderWithTimezone(
      <DependencyUpdatedTime pending value="2026-07-19T00:00:00.000Z" />
    )
    expect(screen.getByText("Awaiting first check")).toBeDefined()
  })
})

describe("DependencyStatusBadge", () => {
  it("renders 'Checking' rather than 'Unknown' while the first poll is pending", () => {
    render(<DependencyStatusBadge pending state="UNKNOWN" />)
    expect(screen.getByText("Checking")).toBeDefined()
    expect(screen.queryByText("Unknown")).toBeNull()
  })

  it("renders 'Unknown' once polling works but the feed could not resolve the component", () => {
    render(<DependencyStatusBadge pending={false} state="UNKNOWN" />)
    expect(screen.getByText("Unknown")).toBeDefined()
    expect(screen.queryByText("Checking")).toBeNull()
  })

  it("renders the resolved state label for a settled dependency", () => {
    render(<DependencyStatusBadge pending={false} state="OPERATIONAL" />)
    expect(screen.getByText("Operational")).toBeDefined()
  })
})

describe("DependencyFidelityBadge", () => {
  it("renders the 'Incident feed only' chip for an incident_only dependency", () => {
    render(<DependencyFidelityBadge fidelity="incident_only" />)
    expect(screen.getByText(INCIDENT_FEED_ONLY_LABEL)).toBeDefined()
    expect(INCIDENT_FEED_ONLY_LABEL).toBe("Incident feed only")
  })

  it("renders nothing for a component-fidelity dependency", () => {
    const { container } = render(
      <DependencyFidelityBadge fidelity="component" />
    )
    expect(container.firstChild).toBeNull()
  })
})
