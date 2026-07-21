import { describe, expect, it } from "vitest"

import {
  buildPaletteGroups,
  filterPaletteGroups,
  nextPaletteIndex,
  type PaletteDependency,
  type PaletteIncident,
  type PaletteMonitor,
} from "./command-palette"

const monitors: PaletteMonitor[] = [
  { id: "api", name: "Public API", state: "DOWN", latestLatencyMs: 503 },
  { id: "web", name: "Website", state: "UP", latestLatencyMs: 42 },
]
const dependencies: PaletteDependency[] = [
  {
    id: "stripe",
    name: "Stripe",
    state: "OPERATIONAL",
    pending: false,
    provider: "Stripe",
    componentLabel: "Payments",
  },
  {
    id: "s3",
    name: "S3",
    state: "OUTAGE",
    pending: false,
    provider: "AWS",
    componentLabel: null,
  },
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
  it("builds navigation, monitor, dependency, and DOWN-only live incident groups", () => {
    const groups = buildPaletteGroups(
      monitors,
      dependencies,
      incidents,
      new Date("2026-07-18T12:00:00.000Z")
    )

    expect(groups.map((group) => group.label)).toEqual([
      "Navigation",
      "Monitors",
      "Dependencies",
      "Live Incidents",
    ])
    expect(groups[1]!.items.map((item) => item.hint)).toEqual(["Down", "42 ms"])
    expect(groups[2]?.items).toEqual([
      expect.objectContaining({
        text: "Stripe",
        hint: "Stripe · Payments",
        href: "/dependencies/stripe",
        dependencyState: "OPERATIONAL",
      }),
      expect.objectContaining({
        text: "S3",
        hint: "AWS",
        href: "/dependencies/s3",
        dependencyState: "OUTAGE",
      }),
    ])
    expect(groups[3]?.items).toEqual([
      expect.objectContaining({
        text: "Public API — HTTP 503",
        hint: "ongoing · 30m 0s",
        href: "/incidents",
      }),
    ])
  })

  it("omits Dependencies when the account has none", () => {
    const groups = buildPaletteGroups(
      monitors.map((monitor) => ({ ...monitor, state: "UP" })),
      [],
      []
    )
    expect(groups.map((group) => group.label)).toEqual([
      "Navigation",
      "Monitors",
    ])
  })

  it("omits Live Incidents when no monitor is down", () => {
    const groups = buildPaletteGroups(
      monitors.map((monitor) => ({ ...monitor, state: "UP" })),
      dependencies,
      []
    )
    expect(groups.map((group) => group.label)).toEqual([
      "Navigation",
      "Monitors",
      "Dependencies",
    ])
  })

  it("filters case-insensitively and removes empty groups", () => {
    const filtered = filterPaletteGroups(
      buildPaletteGroups(monitors, dependencies, incidents),
      "http 503"
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.label).toBe("Live Incidents")
  })

  it("matches dependencies on name, provider, and region label", () => {
    const groups = buildPaletteGroups(monitors, dependencies, incidents)
    expect(
      filterPaletteGroups(groups, "payments").map((group) => group.label)
    ).toEqual(["Dependencies"])
    expect(
      filterPaletteGroups(groups, "aws").map((group) => group.label)
    ).toEqual(["Dependencies"])
    const byProvider = filterPaletteGroups(groups, "stripe")
    expect(byProvider).toHaveLength(1)
    expect(byProvider[0]!.items.map((item) => item.text)).toEqual(["Stripe"])
  })

  it("clamps arrow navigation to the available range", () => {
    expect(nextPaletteIndex(0, "ArrowUp", 4)).toBe(0)
    expect(nextPaletteIndex(0, "ArrowDown", 4)).toBe(1)
    expect(nextPaletteIndex(3, "ArrowDown", 4)).toBe(3)
    expect(nextPaletteIndex(2, "ArrowDown", 0)).toBe(0)
  })
})
