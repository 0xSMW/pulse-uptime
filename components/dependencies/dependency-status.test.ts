import { describe, expect, it } from "vitest"

import {
  dependencyPendingLabel,
  dependencyStateLabels,
  dependencyStatusLabel,
} from "./dependency-status"

describe("dependencyStatusLabel", () => {
  it("returns the resolved state label once the first poll has landed", () => {
    expect(dependencyStatusLabel("OPERATIONAL", false)).toBe("Operational")
    expect(dependencyStatusLabel("DEGRADED", false)).toBe("Degraded")
    expect(dependencyStatusLabel("OUTAGE", false)).toBe("Outage")
    expect(dependencyStatusLabel("MAINTENANCE", false)).toBe("Maintenance")
  })

  it("keeps Unknown as Unknown when a poll succeeded but the feed could not resolve the component", () => {
    expect(dependencyStatusLabel("UNKNOWN", false)).toBe("Unknown")
  })

  it("reads Checking while the first poll is pending, regardless of the placeholder state", () => {
    expect(dependencyStatusLabel("UNKNOWN", true)).toBe(dependencyPendingLabel)
    expect(dependencyStatusLabel("UNKNOWN", true)).toBe("Checking")
    expect(dependencyStatusLabel("OPERATIONAL", true)).toBe("Checking")
  })

  it("never surfaces the raw Unknown label while pending", () => {
    expect(dependencyStatusLabel("UNKNOWN", true)).not.toBe(
      dependencyStateLabels.UNKNOWN
    )
  })
})
