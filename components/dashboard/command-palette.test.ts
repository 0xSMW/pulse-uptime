import { describe, expect, it } from "vitest"

import {
  buildPaletteGroups,
  filterPaletteGroups,
  nextPaletteIndex,
  type PaletteIncident,
  type PaletteMonitor,
} from "./command-palette"

const monitors: PaletteMonitor[] = [
  { id: "api", name: "Public API", state: "DOWN", latestLatencyMs: 503 },
  { id: "web", name: "Website", state: "UP", latestLatencyMs: 42 },
]
const incidents: PaletteIncident[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    monitorId: "api",
    monitorName: "Public API",
    openedAt: "2026-07-18T11:30:00.000Z",
    cause: "HTTP 503",
  },
]

describe("command palette helpers", () => {
  it("builds navigation, monitor, and DOWN-only live incident groups", () => {
    const groups = buildPaletteGroups(
      monitors,
      incidents,
      new Date("2026-07-18T12:00:00.000Z")
    )

    expect(groups.map((group) => group.label)).toEqual([
      "Navigation",
      "Monitors",
      "Live Incidents",
    ])
    expect(groups[1]!.items.map((item) => item.hint)).toEqual(["Down", "42 ms"])
    expect(groups[2]?.items).toEqual([
      expect.objectContaining({
        text: "Public API — HTTP 503",
        hint: "ongoing · 30m 0s",
        href: "/incidents",
      }),
    ])
  })

  it("omits Live Incidents when no monitor is down", () => {
    const groups = buildPaletteGroups(
      monitors.map((monitor) => ({ ...monitor, state: "UP" })),
      []
    )
    expect(groups.map((group) => group.label)).toEqual([
      "Navigation",
      "Monitors",
    ])
  })

  it("filters case-insensitively and removes empty groups", () => {
    const filtered = filterPaletteGroups(
      buildPaletteGroups(monitors, incidents),
      "http 503"
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.label).toBe("Live Incidents")
  })

  it("clamps arrow navigation to the available range", () => {
    expect(nextPaletteIndex(0, "ArrowUp", 4)).toBe(0)
    expect(nextPaletteIndex(0, "ArrowDown", 4)).toBe(1)
    expect(nextPaletteIndex(3, "ArrowDown", 4)).toBe(3)
    expect(nextPaletteIndex(2, "ArrowDown", 0)).toBe(0)
  })
})
