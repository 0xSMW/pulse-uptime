import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

import { NotificationsSettings } from "./notifications-settings"

function render(sender: string | null) {
  return renderToStaticMarkup(
    <NotificationsSettings
      data={{ defaultRecipients: ["ops@example.com"], sender }}
    />
  )
}

describe("NotificationsSettings", () => {
  it("renders the recipients form with save and test actions", () => {
    const html = render("Pulse <alerts@example.com>")
    expect(html).toContain("Default Recipients")
    expect(html).toContain("ops@example.com")
    expect(html).toContain("Save Recipients")
    expect(html).toContain("Send Test Email")
    expect(html).toContain("via Resend")
  })

  it("states when no sender is configured", () => {
    const html = render(null)
    expect(html).toContain("Email sender is not configured")
  })

  it("holds only notification content — appearance moved to Account", () => {
    const html = render(null)
    expect(html).not.toContain("Appearance")
    expect(html).not.toContain("Time zone")
  })
})
