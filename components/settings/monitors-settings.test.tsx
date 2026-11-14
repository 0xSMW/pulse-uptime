import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { type MonitorSettingsData, MonitorsSettings } from "./monitors-settings"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const data: MonitorSettingsData = {
  monitors: [
    {
      id: "api-prod",
      name: "API Production",
      url: "https://api.example.com/health",
      enabled: true,
      groupId: "core",
      group: "Core",
      method: "GET",
      intervalMinutes: 1,
      timeoutMs: 8000,
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      failureThreshold: 2,
      recoveryThreshold: 2,
      recipients: [],
      state: "UP",
    },
  ],
  groups: [
    { id: "core", name: "Core", monitorCount: 1 },
    { id: "empty", name: "Empty", monitorCount: 0 },
  ],
  userAgent: "Pulse/1.0",
}

describe("MonitorsSettings", () => {
  it("renders the monitor row with an edit trigger and no view link", () => {
    const html = renderToStaticMarkup(<MonitorsSettings data={data} />)
    expect(html).toContain("API Production")
    expect(html).toContain("GET · 1m · 8s timeout")
    expect(html).not.toContain('href="/monitors/api-prod"')
    expect(html).toContain('aria-label="Edit API Production"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
  })

  it("keeps the configuration summary on one line", () => {
    const html = renderToStaticMarkup(<MonitorsSettings data={data} />)
    expect(html).toMatch(/whitespace-nowrap[^>]*>GET · 1m · 8s timeout</)
  })

  it("wraps long monitor names, URLs, and group names instead of truncating", () => {
    const url =
      "https://api.example.com/v2/health/checks/deep?region=ap-southeast-1&probe=uptime"
    const html = renderToStaticMarkup(
      <MonitorsSettings
        data={{
          ...data,
          monitors: [{ ...data.monitors[0]!, url }],
          groups: [
            { id: "core", name: "Core-services-production", monitorCount: 1 },
          ],
        }}
      />
    )
    expect(html).not.toContain("truncate")
    expect(html).toContain(url.replaceAll("&", "&amp;"))
    expect(html).toMatch(/wrap-anywhere[^>]*>Core-services-production</)
    expect(html).toMatch(/wrap-anywhere[^>]*>Pulse\/1.0</)
  })

  it("guards deletion of non-empty groups and allows it for empty ones", () => {
    const html = renderToStaticMarkup(<MonitorsSettings data={data} />)
    expect(html).toContain("Move monitors before deleting")
    expect(html).toContain('title="Move monitors before deleting this group"')
    expect(html).toContain("1 monitor")
    expect(html).toContain("0 monitors")
  })

  it("shows the check user agent under Defaults", () => {
    const html = renderToStaticMarkup(<MonitorsSettings data={data} />)
    expect(html).toContain("Defaults")
    expect(html).toContain("Check user agent")
    expect(html).toContain("Pulse/1.0")
  })

  it("renders an empty state without monitors", () => {
    const html = renderToStaticMarkup(
      <MonitorsSettings data={{ ...data, monitors: [] }} />
    )
    expect(html).toContain("No monitors configured")
  })
})
