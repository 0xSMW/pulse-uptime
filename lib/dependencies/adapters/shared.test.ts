import { describe, expect, it } from "vitest"

import {
  isTerminalIncidentState,
  terminalResolvedAt,
  toBoundedPlainText,
} from "./shared"

const MAX_BODY_BYTES = 4096

describe("isTerminalIncidentState", () => {
  it("treats resolved, completed, and false_alarm as terminal", () => {
    expect(isTerminalIncidentState("resolved")).toBe(true)
    expect(isTerminalIncidentState("completed")).toBe(true)
    expect(isTerminalIncidentState("false_alarm")).toBe(true)
  })

  it("treats active lifecycle values as non-terminal", () => {
    for (const state of [
      "investigating",
      "identified",
      "monitoring",
      "scheduled",
      "in_progress",
      "recovering",
    ]) {
      expect(isTerminalIncidentState(state)).toBe(false)
    }
  })
})

describe("terminalResolvedAt", () => {
  const startedAt = "2026-07-20T08:00:00.000Z"
  const updatedAt = "2026-07-20T10:00:00.000Z"

  it("returns null for active states even when an explicit end time is present", () => {
    expect(
      terminalResolvedAt({
        state: "investigating",
        startedAt,
        explicitResolvedAt: updatedAt,
        providerUpdatedAt: updatedAt,
      })
    ).toBeNull()
  })

  it("prefers the explicit resolution timestamp for terminal states", () => {
    expect(
      terminalResolvedAt({
        state: "resolved",
        startedAt,
        explicitResolvedAt: "2026-07-20T09:30:00.000Z",
        providerUpdatedAt: updatedAt,
      })
    ).toBe("2026-07-20T09:30:00.000Z")
  })

  it("falls back to the provider update timestamp when no explicit end is set", () => {
    expect(
      terminalResolvedAt({
        state: "completed",
        startedAt,
        explicitResolvedAt: null,
        providerUpdatedAt: updatedAt,
      })
    ).toBe(updatedAt)
  })

  it("orders resolution at or after startedAt", () => {
    expect(
      terminalResolvedAt({
        state: "false_alarm",
        startedAt,
        explicitResolvedAt: "2026-07-20T07:00:00.000Z",
        providerUpdatedAt: "2026-07-20T07:30:00.000Z",
      })
    ).toBe(startedAt)
  })
})

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

describe("toBoundedPlainText byte capping", () => {
  it("returns short strings unchanged", () => {
    expect(toBoundedPlainText("a short incident note")).toBe(
      "a short incident note"
    )
  })

  it("caps a hundreds of KB ASCII body within the byte limit and fast", () => {
    const huge = "a".repeat(500_000)
    const start = performance.now()
    const result = toBoundedPlainText(huge)
    const elapsed = performance.now() - start
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES)
    expect(utf8Length(result)).toBe(MAX_BODY_BYTES)
    // The old O(n^2) implementation took tens of seconds on an input this size.
    // A generous bound still catches any regression to per character encoding.
    expect(elapsed).toBeLessThan(1000)
  })

  it("caps a hundreds of KB multibyte body on a code point boundary", () => {
    // The euro sign is three UTF-8 bytes, so the cap of 4096 lands mid character
    // and forces the back off to the nearest boundary.
    const huge = "€".repeat(200_000)
    const start = performance.now()
    const result = toBoundedPlainText(huge)
    const elapsed = performance.now() - start
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES)
    // 4096 / 3 = 1365 whole characters, so 4095 bytes with no split sequence.
    expect(utf8Length(result)).toBe(4095)
    // Round tripping proves the result is valid UTF-8 with no dangling bytes.
    expect(
      utf8Length(new TextDecoder().decode(new TextEncoder().encode(result)))
    ).toBe(4095)
    expect(result.endsWith("€")).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })

  it("never splits a surrogate pair when capping emoji", () => {
    const huge = "\u{1F600}".repeat(200_000)
    const result = toBoundedPlainText(huge)
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES)
    // Each emoji is four UTF-8 bytes, so a clean cut keeps 1024 of them intact.
    expect([...result]).toHaveLength(1024)
    expect(result.endsWith("\u{1F600}")).toBe(true)
  })
})
