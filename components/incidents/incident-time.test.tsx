// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import { formatIncidentRange } from "@/components/incidents/incident-format"
import { IncidentTimeRange } from "@/components/incidents/incident-time"

afterEach(() => {
  cleanup()
})

function renderRange(startAt: string, endAt: string, zone: string) {
  const { container } = render(
    <TimezoneProvider defaultTimezone={zone}>
      <p>
        <IncidentTimeRange endAt={endAt} startAt={startAt} />
      </p>
    </TimezoneProvider>
  )
  const root = container.querySelector("p") as HTMLElement
  const chunks = [...root.querySelectorAll("span.whitespace-nowrap")].map(
    (span) => span.textContent
  )
  return { root, chunks }
}

describe("IncidentTimeRange", () => {
  it("keeps the condensed same-day text and holds the zone with its time", () => {
    const startAt = "2026-11-13T19:00:00Z"
    const endAt = "2026-11-14T06:16:00Z"
    const zone = "America/Los_Angeles"
    const { root, chunks } = renderRange(startAt, endAt, zone)
    expect(root.textContent).toBe(formatIncidentRange(startAt, endAt, zone))
    expect(chunks).toEqual(["Nov 13", "11:00", "22:16 PST"])
    expect(root.classList.contains("whitespace-nowrap")).toBe(false)
  })

  it("keeps both dates intact across local midnight", () => {
    const startAt = "2026-11-13T23:00:00Z"
    const endAt = "2026-11-14T00:16:00Z"
    const { root, chunks } = renderRange(startAt, endAt, "UTC")
    expect(root.textContent).toBe("Nov 13, 23:00–Nov 14, 00:16 UTC")
    expect(chunks).toEqual(["Nov 13", "23:00", "Nov 14", "00:16 UTC"])
  })

  it("keeps each DST zone with its own time", () => {
    const startAt = "2026-11-01T08:30:00Z"
    const endAt = "2026-11-01T09:30:00Z"
    const { root, chunks } = renderRange(startAt, endAt, "America/Los_Angeles")
    expect(root.textContent).toBe("Nov 1, 01:30 PDT–01:30 PST")
    expect(chunks).toEqual(["Nov 1", "01:30 PDT", "01:30 PST"])
  })
})
