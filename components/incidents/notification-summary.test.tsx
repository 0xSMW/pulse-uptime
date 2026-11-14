import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { NotificationSummary } from "./notification-summary"

describe("NotificationSummary", () => {
  it("labels undeliverable notifications as failed", () => {
    const html = renderToStaticMarkup(
      <NotificationSummary summary={{ state: "dead", sentCount: 0 }} />
    )
    expect(html).toContain("Failed")
    expect(html).not.toContain("Dead")
    expect(html).toContain("text-[var(--down-text)]")
  })

  it("shows the sent count", () => {
    const html = renderToStaticMarkup(
      <NotificationSummary summary={{ state: "sent", sentCount: 2 }} />
    )
    expect(html).toContain("Sent · 2")
  })
})
