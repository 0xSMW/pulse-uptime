import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HealthBanner } from "./health-banner"

const warnings = [
  {
    code: "check-stale",
    message: "Scheduled checks are delayed",
    action: "Check Vercel Cron",
  },
  {
    code: "notification-dead",
    message: "Some alerts could not send",
    action: "Review Notifications",
  },
]

describe("HealthBanner", () => {
  it("renders nothing without warnings", () => {
    expect(
      renderToStaticMarkup(<HealthBanner canOpenSystem warnings={[]} />)
    ).toBe("")
  })

  it("lists every warning instead of a hidden count", () => {
    const html = renderToStaticMarkup(
      <HealthBanner canOpenSystem warnings={warnings} />
    )
    expect(html).toContain("Scheduled checks are delayed")
    expect(html).toContain("Some alerts could not send")
    expect(html).not.toContain("more checks need attention")
  })

  it("links admin actions to System settings", () => {
    const html = renderToStaticMarkup(
      <HealthBanner canOpenSystem warnings={warnings} />
    )
    expect(html.match(/href="\/settings\/system"/g)).toHaveLength(2)
    expect(html).toContain("Check Vercel Cron")
    expect(html).toContain("Review Notifications")
    expect(html).not.toContain("<button")
  })

  it("gives viewers plain guidance without dead controls", () => {
    const html = renderToStaticMarkup(
      <HealthBanner canOpenSystem={false} warnings={warnings} />
    )
    expect(html).not.toContain("/settings/system")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("Check Vercel Cron")
    expect(html).toContain("Ask an admin to check System settings")
  })
})
