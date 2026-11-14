import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import type { DependencyDashboardRow } from "@/lib/dependencies/queries"
import { DependencyPanelRow } from "./dependency-row"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const dependency: DependencyDashboardRow = {
  id: "dep-1",
  presetId: "cloud-provider",
  scopeId: "ap-southeast-1",
  componentLabel: "Compute Engine asia-southeast1-b managed instance groups",
  name: "Cloud Provider Compute Engine Asia Southeast",
  provider: "Cloud Provider",
  category: "cloud",
  fidelity: "component",
  state: "DEGRADED",
  pendingFirstPoll: false,
  providerUpdatedAt: "2026-11-13T08:00:00.000Z",
  activeIncidentTitle:
    "Elevated error rates for managed instance group autoscaling in asia-southeast1",
  timeline24h: [],
}

function markup() {
  return renderToStaticMarkup(
    <TimezoneProvider>
      <table>
        <tbody>
          <DependencyPanelRow dependency={dependency} showIncident />
        </tbody>
      </table>
    </TimezoneProvider>
  )
}

describe("DependencyPanelRow", () => {
  it("wraps the name, component, and incident title instead of truncating", () => {
    const html = markup()
    expect(html).not.toContain("truncate")
    expect(html).not.toContain(`title="${dependency.activeIncidentTitle}"`)
    expect(html).toMatch(
      new RegExp(`wrap-anywhere[^>]*>${dependency.name}</a>`)
    )
    expect(html).toContain(`· ${dependency.componentLabel}`)
    expect(html).toMatch(
      new RegExp(`wrap-anywhere[^>]*>${dependency.activeIncidentTitle}</td>`)
    )
  })
})
