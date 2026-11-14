// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { HealthWarning } from "@/lib/monitoring/types"
import { MonitoringLoopCard } from "./monitoring-health"

afterEach(() => {
  cleanup()
})

describe("MonitoringLoopCard", () => {
  it("shows only the header and Running chip when healthy", () => {
    const { container } = render(<MonitoringLoopCard warnings={[]} />)
    expect(screen.getByText("Monitoring Loop")).toBeDefined()
    expect(screen.getByText("Running")).toBeDefined()
    expect(screen.queryByText(/running on time/)).toBeNull()
    expect(container.querySelectorAll("p")).toHaveLength(0)
  })

  it("keeps the warning list when the loop needs attention", () => {
    const warnings: HealthWarning[] = [
      {
        code: "SCHEDULER_STALE",
        message: "Scheduled checks are late",
        action: "Check the cron job",
      },
    ]
    render(<MonitoringLoopCard warnings={warnings} />)
    expect(screen.getByText("Needs attention")).toBeDefined()
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Scheduled checks are late")
    expect(alert.textContent).toContain("Check the cron job")
  })
})
