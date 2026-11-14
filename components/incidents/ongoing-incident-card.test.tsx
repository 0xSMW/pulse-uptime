import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import { OngoingIncidentCard } from "./ongoing-incident-card"
import type { IncidentSummary } from "./types"

const incident: IncidentSummary = {
  id: "inc-1",
  monitorId: "api-prod",
  monitorName: "payments-gateway-production-ap-southeast-1-primary-health",
  openedAt: "2026-11-13T08:00:00.000Z",
  resolvedAt: null,
  durationSeconds: 600,
  openingFailure:
    "HTTP 503 from https://payments.example.com/v2/health?probe=uptime&region=ap",
  notificationSummary: { state: "sent", sentCount: 1 },
}

describe("OngoingIncidentCard", () => {
  it("wraps the monitor name and failure instead of truncating", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <OngoingIncidentCard incident={incident} />
      </TimezoneProvider>
    )
    expect(html).not.toContain("truncate")
    expect(html).toMatch(
      new RegExp(`wrap-anywhere[^>]*>${incident.monitorName}</a>`)
    )
    expect(html).toMatch(/wrap-anywhere[^>]*>HTTP 503 from https:/)
  })
})
