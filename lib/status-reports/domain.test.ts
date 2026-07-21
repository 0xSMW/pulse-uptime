import { describe, expect, it } from "vitest"

import {
  filterReportsForGroup,
  IMPACT_BY_TYPE,
  impactOptions,
  isResolvingStatus,
  REPORT_STATUS_LABELS,
  REPORT_STATUSES,
  type ReportImpact,
} from "./domain"

function report(
  affected: Array<{ monitorId: string; groupName?: string | null }>
) {
  return {
    affected: affected.map((entry) => ({
      monitorId: entry.monitorId,
      groupName: entry.groupName ?? null,
    })),
  }
}

describe("filterReportsForGroup", () => {
  const visibleMonitorIds = new Set(["api-prod", "worker"])

  it("keeps reports matching a visible monitor id in the group", () => {
    const matching = report([{ monitorId: "api-prod", groupName: "Old Group" }])
    expect(
      filterReportsForGroup([matching], { slug: "apis", visibleMonitorIds })
    ).toEqual([matching])
  })

  it("keeps reports matching the slug of the snapshotted group name", () => {
    // The monitor was archived (not visible), but the snapshot name slugs to
    // the requested group slug.
    const matching = report([{ monitorId: "api-archived", groupName: "APIs" }])
    expect(
      filterReportsForGroup([matching], { slug: "apis", visibleMonitorIds })
    ).toEqual([matching])
  })

  it("matches even when the snapshot spells the group with accents or case the slug folds away", () => {
    const matching = report([{ monitorId: "gone", groupName: "Café" }])
    expect(
      filterReportsForGroup([matching], { slug: "cafe", visibleMonitorIds })
    ).toEqual([matching])
  })

  it("collapses null group names to the Other bucket", () => {
    const matching = report([{ monitorId: "gone", groupName: null }])
    expect(
      filterReportsForGroup([matching], { slug: "other", visibleMonitorIds })
    ).toEqual([matching])
    expect(
      filterReportsForGroup([matching], { slug: "apis", visibleMonitorIds })
    ).toEqual([])
  })

  it("drops reports with no overlap and reports with no affected services", () => {
    const other = report([{ monitorId: "db", groupName: "Databases" }])
    expect(
      filterReportsForGroup([other, report([])], {
        slug: "apis",
        visibleMonitorIds,
      })
    ).toEqual([])
  })
})

describe("vocabulary", () => {
  it("orders the per-type update statuses", () => {
    expect(REPORT_STATUSES.incident).toEqual([
      "investigating",
      "identified",
      "monitoring",
      "resolved",
    ])
    expect(REPORT_STATUSES.maintenance).toEqual([
      "scheduled",
      "in_progress",
      "completed",
    ])
  })

  it("labels every update status", () => {
    expect(REPORT_STATUS_LABELS.in_progress).toBe("In progress")
    expect(REPORT_STATUS_LABELS.investigating).toBe("Investigating")
  })

  it("scopes the impact vocabulary to the report type", () => {
    expect(IMPACT_BY_TYPE.incident).toEqual<readonly ReportImpact[]>([
      "down",
      "degraded",
    ])
    expect(IMPACT_BY_TYPE.maintenance).toEqual<readonly ReportImpact[]>([
      "maintenance",
      "degraded",
    ])
  })

  it("scopes the editor impact options to the report type", () => {
    expect(impactOptions("incident").map((option) => option.value)).toEqual([
      "none",
      "degraded",
      "down",
    ])
    expect(impactOptions("maintenance").map((option) => option.value)).toEqual([
      "none",
      "maintenance",
      "degraded",
    ])
  })

  it("flags the resolving statuses only", () => {
    expect(isResolvingStatus("resolved")).toBe(true)
    expect(isResolvingStatus("completed")).toBe(true)
    expect(isResolvingStatus("monitoring")).toBe(false)
    expect(isResolvingStatus("scheduled")).toBe(false)
  })
})
