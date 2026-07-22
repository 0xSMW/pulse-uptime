import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

import { NewMonitorAction } from "./new-monitor-action"

describe("NewMonitorAction", () => {
  it("omits the create control for viewers", () => {
    expect(
      renderToStaticMarkup(<NewMonitorAction canManageMonitors={false} />)
    ).toBe("")
  })

  it("retains the create control for admins", () => {
    const html = renderToStaticMarkup(
      <NewMonitorAction canManageMonitors={true} />
    )

    expect(html).toContain('aria-label="New monitor"')
    expect(html).toContain("New Monitor")
    expect(html).toContain('aria-label="More monitor actions"')
  })
})
