import { describe, expect, it } from "vitest"

import type { ExclusionSlot } from "@/lib/incidents/exclusions"
import { displayTimelineBuckets } from "@/lib/status-page/display"
import { exclusionVersion, overlayExclusions } from "./exclusions"
import { summarizeCounts } from "./first-run"
import {
  buildRecentChecks,
  buildRecentChecksFromRaw,
  observedWithRawTail,
} from "./live-summary"
import {
  blendRawAvailability,
  buildRollupTimeline,
  summarizeRollupCoverage,
} from "./timeline"

const start = new Date("2026-11-13T12:00:00Z")
const end = new Date("2026-11-13T12:15:00Z")
const slot = (minute: number, failed = true): ExclusionSlot => ({
  monitorId: "site",
  scheduledMinute: new Date(start.getTime() + minute * 60_000),
  failed,
  downtimeSeconds: 60,
})
const row = (successful: number, failed: number, unknown = 0) => ({
  bucketStart: start,
  expectedChecks: successful + failed + unknown,
  completedChecks: successful + failed,
  successfulChecks: successful,
  failedChecks: failed,
  unknownChecks: unknown,
  downtimeSeconds: failed * 60,
})
const timeline = (rows: ReturnType<typeof row>[]) =>
  buildRollupTimeline(rows, 1, 900_000, end)[0]!

describe("persistent availability exclusions", () => {
  it("removes failed checks from eligibility while preserving observed counts and coverage", () => {
    const observed = row(2, 2, 1)
    const adjusted = overlayExclusions([observed], [slot(1)], "15m", "site")
    const summary = summarizeCounts(adjusted)
    expect(summary.uptime).toBeCloseTo(200 / 3)
    expect(summary.coverage).toBe(4 / 5)
    expect(summary).toMatchObject({
      completed: 4,
      failed: 2,
      successful: 2,
      excluded: 1,
    })
    expect(observed.failedChecks).toBe(2)
    expect(timeline(adjusted)).toMatchObject({
      failures: 1,
      excludedChecks: 1,
      downtimeSeconds: 60,
    })
    expect(summarizeRollupCoverage(adjusted)).toEqual({
      uptime: summary.uptime,
      coverage: 4 / 5,
    })
  })

  it("keeps excluded-only periods neutral with null uptime even when unknown is operational", () => {
    const adjusted = overlayExclusions(
      [row(0, 2, 1)],
      [slot(1), slot(2)],
      "15m",
      "site"
    )
    expect(summarizeCounts(adjusted)).toMatchObject({
      uptime: null,
      coverage: 2 / 3,
    })
    const bucket = timeline(adjusted)
    expect(bucket).toMatchObject({
      state: "excluded",
      failures: 0,
      excludedChecks: 2,
      downtimeSeconds: 0,
    })
    expect(displayTimelineBuckets([bucket], true)[0]?.state).toBe("excluded")
  })

  it("preserves raw zero downtime and matches counts after raw-to-rollup handoff", () => {
    const slots = [slot(1)]
    const raw = overlayExclusions(
      [{ ...row(1, 1), downtimeSeconds: 0 }],
      slots,
      "15m",
      "site",
      { raw: true }
    )
    const compacted = overlayExclusions([row(1, 1)], slots, "15m", "site")
    expect(timeline(raw).downtimeSeconds).toBe(0)
    expect(timeline(compacted).downtimeSeconds).toBe(0)
    expect(summarizeCounts(blendRawAvailability(compacted, raw))).toEqual(
      summarizeCounts(raw)
    )
    expect(blendRawAvailability(compacted, raw)).toHaveLength(1)
  })

  it("retains exact hour and day corrections without raw source rows and restores on undo", () => {
    const slots = [slot(1), slot(2, false)]
    for (const resolution of ["hour", "day"] as const) {
      const observed = {
        ...row(2, 1),
        bucketStart: new Date(
          resolution === "hour"
            ? "2026-11-13T12:00:00Z"
            : "2026-11-13T00:00:00Z"
        ),
        downtimeSeconds: 120,
      }
      const active = overlayExclusions([observed], slots, resolution, "site")
      expect(summarizeCounts(active).uptime).toBe(100)
      expect(active[0]).toMatchObject({
        excludedChecks: 1,
        excludedDowntimeSeconds: 120,
      })
      const undone = overlayExclusions([observed], [], resolution, "site")
      expect(summarizeCounts(undone).uptime).toBeCloseTo(200 / 3)
      expect(undone[0]?.downtimeSeconds).toBe(120)
      expect(undone[0]?.excludedDowntimeSeconds).toBe(0)
    }
  })

  it("excludes only the uncounted collecting tail and retains original recent check failure", () => {
    const excluded = 1
    expect(
      observedWithRawTail([row(1, 0)], {
        expected: 1,
        completed: 1,
        successful: 0,
        failed: 1,
        excluded,
      })
    ).toMatchObject({ uptime: 100, coverage: 1, completed: 2 })
    expect(
      buildRecentChecksFromRaw([
        {
          checked_at: slot(1).scheduledMinute,
          completed: true,
          failed: true,
          excluded: true,
          latency_ms: 100,
        },
      ])[0]
    ).toMatchObject({
      successful: false,
      excluded: true,
      resultLabel: "Excluded · Failed",
      latencyMs: 100,
    })
  })

  it("keeps unknown coverage visible in excluded rollup check summaries", () => {
    const check = buildRecentChecks([
      { ...row(0, 1, 1), excludedChecks: 1, latencyCount: 0, latencySumMs: 0n },
    ])[0]
    expect(check).toMatchObject({
      excluded: true,
      successful: false,
      resultLabel: "Unknown coverage · 1 excluded",
    })
  })

  it("scopes slots by monitor and makes revision independent of row order but sensitive to undo", () => {
    const slots = [slot(1), slot(2)]
    expect(
      overlayExclusions([row(1, 1)], slots, "15m", "other")[0]?.excludedChecks
    ).toBe(0)
    expect(exclusionVersion(slots)).toBe(exclusionVersion([...slots].reverse()))
    expect(exclusionVersion(slots)).not.toBe(exclusionVersion([]))
    expect(
      overlayExclusions([row(1, 1)], [slot(1), slot(1)], "15m", "site")[0]
        ?.excludedChecks
    ).toBe(1)
  })
})
