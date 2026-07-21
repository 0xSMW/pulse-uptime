// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { TimelineBucket } from "@/lib/monitoring/types"

import { TimelineBar } from "./timeline-bar"

// jsdom has no layout engine, so Base UI's positioner touches pointer capture
// and scroll APIs that are unimplemented. Stub them so opening the tooltip
// popup does not throw.
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
})

afterEach(() => {
  cleanup()
})

const buckets: TimelineBucket[] = [
  {
    state: "up",
    label: "2026-07-20T07:30:00.000Z–2026-07-20T07:45:00.000Z",
    checks: 4,
    failures: 0,
    startMs: Date.parse("2026-07-20T07:30:00.000Z"),
    endMs: Date.parse("2026-07-20T07:45:00.000Z"),
  },
  {
    state: "down",
    label: "2026-07-20T07:45:00.000Z–2026-07-20T08:00:00.000Z",
    checks: 4,
    failures: 4,
    startMs: Date.parse("2026-07-20T07:45:00.000Z"),
    endMs: Date.parse("2026-07-20T08:00:00.000Z"),
  },
]

describe("TimelineBar tooltips", () => {
  it("keeps the bar as a single non-focusable image summary", () => {
    render(
      <TimelineBar
        buckets={buckets}
        label="Last 24 hours"
        timeZone="Asia/Bangkok"
      />
    )
    const bar = screen.getByRole("img", {
      name: "Last 24 hours: 8 checks, 4 failed",
    })
    expect(bar.querySelectorAll("button, a, [tabindex]").length).toBe(0)
  })

  it("shows the hovered cell's range, state, and check counts in the viewer zone", () => {
    render(
      <TimelineBar
        buckets={buckets}
        label="Last 24 hours"
        timeZone="Asia/Bangkok"
      />
    )
    const cells = screen.getByRole("img").querySelectorAll("span")

    fireEvent.pointerEnter(cells[0]!)
    expect(screen.getByText("Jul 20, 14:30 to 14:45")).toBeTruthy()
    expect(screen.getByText(/Operational · 4 checks/)).toBeTruthy()

    fireEvent.pointerEnter(cells[1]!)
    expect(screen.getByText("Jul 20, 14:45 to 15:00")).toBeTruthy()
    expect(screen.getByText(/Down · 4 checks, 4 failed/)).toBeTruthy()
  })

  it("falls back to the ISO label range when a bucket carries no structured times", () => {
    const labelOnly: TimelineBucket[] = [
      {
        state: "up",
        label: "2026-07-20T07:30:00.000Z–2026-07-20T07:45:00.000Z",
        checks: 1,
        failures: 0,
      },
    ]
    render(
      <TimelineBar
        buckets={labelOnly}
        label="Dependency"
        timeZone="Asia/Bangkok"
      />
    )
    fireEvent.pointerEnter(screen.getByRole("img").querySelector("span")!)
    expect(screen.getByText("Jul 20, 14:30 to 14:45")).toBeTruthy()
  })
})
