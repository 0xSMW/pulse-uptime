import { describe, expect, it } from "vitest"

import {
  BEFORE_START_COPY,
  currentStatusAfterEdit,
  formatUpdateCount,
  fromDatetimeLocal,
  impactOptions,
  isBeforeStart,
  type ReportUpdateData,
  reportDotState,
  STATE_FLIP_COPY,
  stateFlipAfterRemoval,
  stateFlipDirection,
  toDatetimeLocal,
  validateReportForm,
} from "./report-status"

const updates: ReportUpdateData[] = [
  {
    id: "u2",
    status: "resolved",
    markdown: "Fixed.",
    publishedAt: "2026-07-18T12:00:00.000Z",
  },
  {
    id: "u1",
    status: "monitoring",
    markdown: "Watching.",
    publishedAt: "2026-07-18T10:00:00.000Z",
  },
]

describe("reportDotState", () => {
  it("maps statuses onto the house dot vocabulary", () => {
    expect(reportDotState("investigating")).toBe("DOWN")
    expect(reportDotState("identified")).toBe("DOWN")
    expect(reportDotState("monitoring")).toBe("VERIFYING_UP")
    expect(reportDotState("in_progress")).toBe("VERIFYING_UP")
    expect(reportDotState("resolved")).toBe("UP")
    expect(reportDotState("completed")).toBe("UP")
    expect(reportDotState("scheduled")).toBe("PENDING")
  })
})

describe("currentStatusAfterEdit", () => {
  it("keeps the latest update current when nothing moves", () => {
    expect(currentStatusAfterEdit(updates, { id: "u2" })).toBe("resolved")
  })

  it("recomputes the latest when a timestamp is backdated", () => {
    expect(
      currentStatusAfterEdit(updates, {
        id: "u2",
        publishedAt: "2026-07-18T09:00:00.000Z",
      })
    ).toBe("monitoring")
  })

  it("uses the original order as the tiebreak for identical timestamps", () => {
    expect(
      currentStatusAfterEdit(updates, {
        id: "u1",
        publishedAt: "2026-07-18T12:00:00.000Z",
      })
    ).toBe("resolved")
  })

  it("breaks publishedAt ties by createdAt, matching the server total order", () => {
    // Resolved update A was created first. Update B was created later but
    // backdated. Editing B's publishedAt to equal A's (minute precision) must
    // hand the tie to B. The server orders by (publishedAt, createdAt, id).
    const withCreated: ReportUpdateData[] = [
      {
        id: "a",
        status: "resolved",
        markdown: "Fixed.",
        publishedAt: "2026-07-18T12:00:00.000Z",
        createdAt: "2026-07-18T12:00:10.000Z",
      },
      {
        id: "b",
        status: "monitoring",
        markdown: "Watching.",
        publishedAt: "2026-07-18T10:00:00.000Z",
        createdAt: "2026-07-18T12:30:00.000Z",
      },
    ]
    expect(
      currentStatusAfterEdit(withCreated, {
        id: "b",
        publishedAt: "2026-07-18T12:00:00.000Z",
      })
    ).toBe("monitoring")
  })

  it("breaks full (publishedAt, createdAt) ties by id, matching the server", () => {
    const tied: ReportUpdateData[] = [
      {
        id: "aaa",
        status: "resolved",
        markdown: "Fixed.",
        publishedAt: "2026-07-18T12:00:00.000Z",
        createdAt: "2026-07-18T12:00:00.000Z",
      },
      {
        id: "zzz",
        status: "monitoring",
        markdown: "Watching.",
        publishedAt: "2026-07-18T12:00:00.000Z",
        createdAt: "2026-07-18T12:00:00.000Z",
      },
    ]
    expect(currentStatusAfterEdit(tied, { id: "aaa" })).toBe("monitoring")
  })
})

describe("stateFlipDirection", () => {
  it("returns null when the report state does not change", () => {
    expect(
      stateFlipDirection(updates, { id: "u2", status: "completed" })
    ).toBeNull()
    expect(
      stateFlipDirection(updates, { id: "u1", status: "identified" })
    ).toBeNull()
  })

  it("detects a backdate that moves the report back to Ongoing", () => {
    expect(
      stateFlipDirection(updates, {
        id: "u2",
        publishedAt: "2026-07-18T09:00:00.000Z",
      })
    ).toBe("to_ongoing")
    expect(STATE_FLIP_COPY.to_ongoing).toContain("back to Ongoing")
    expect(STATE_FLIP_COPY.to_ongoing).toContain("top of your status page")
  })

  it("detects a status edit that resolves the report", () => {
    const ongoing: ReportUpdateData[] = [
      {
        id: "u1",
        status: "monitoring",
        markdown: "Watching.",
        publishedAt: "2026-07-18T10:00:00.000Z",
      },
    ]
    expect(stateFlipDirection(ongoing, { id: "u1", status: "resolved" })).toBe(
      "to_resolved"
    )
  })

  it("detects a status edit that reopens the report", () => {
    expect(
      stateFlipDirection(updates, { id: "u2", status: "monitoring" })
    ).toBe("to_ongoing")
  })

  it("fires for a minute-precision tie that the server resolves by createdAt", () => {
    // Editing update B's publishedAt to equal resolved update A's, where B
    // was created later. The server flips to Ongoing.
    const withCreated: ReportUpdateData[] = [
      {
        id: "a",
        status: "resolved",
        markdown: "Fixed.",
        publishedAt: "2026-07-18T12:00:00.000Z",
        createdAt: "2026-07-18T12:00:10.000Z",
      },
      {
        id: "b",
        status: "monitoring",
        markdown: "Watching.",
        publishedAt: "2026-07-18T10:00:00.000Z",
        createdAt: "2026-07-18T12:30:00.000Z",
      },
    ]
    expect(
      stateFlipDirection(withCreated, {
        id: "b",
        publishedAt: "2026-07-18T12:00:00.000Z",
      })
    ).toBe("to_ongoing")
  })
})

describe("stateFlipAfterRemoval", () => {
  it("warns when deleting the latest resolving update reopens the report", () => {
    expect(stateFlipAfterRemoval(updates, "u2")).toBe("to_ongoing")
  })

  it("returns null when removing an update that does not decide the state", () => {
    expect(stateFlipAfterRemoval(updates, "u1")).toBeNull()
  })

  it("warns when deleting the latest ongoing update resolves the report", () => {
    const reopened: ReportUpdateData[] = [
      {
        id: "u2",
        status: "monitoring",
        markdown: "Watching.",
        publishedAt: "2026-07-18T12:00:00.000Z",
      },
      {
        id: "u1",
        status: "resolved",
        markdown: "Fixed.",
        publishedAt: "2026-07-18T10:00:00.000Z",
      },
    ]
    expect(stateFlipAfterRemoval(reopened, "u2")).toBe("to_resolved")
  })

  it("stays silent for the last remaining update — the server refuses it", () => {
    expect(stateFlipAfterRemoval([updates[0]!], "u2")).toBeNull()
  })
})

describe("isBeforeStart", () => {
  it("flags update times before the report start", () => {
    expect(isBeforeStart("2026-07-18T09:59", "2026-07-18T10:00")).toBe(true)
    expect(isBeforeStart("2026-07-18T10:00", "2026-07-18T10:00")).toBe(false)
    expect(isBeforeStart("2026-07-18T10:01", "2026-07-18T10:00")).toBe(false)
    expect(isBeforeStart("", "2026-07-18T10:00")).toBe(false)
    expect(isBeforeStart("2026-07-18T09:59", "")).toBe(false)
    expect(BEFORE_START_COPY).toContain("before the report's start time")
  })
})

describe("validateReportForm", () => {
  const valid = {
    title: "API outage",
    startsAt: "2026-07-18T10:00",
    endsAt: "",
    type: "incident" as const,
    requireUpdate: true,
    markdown: "We are investigating.",
    publishedAt: "2026-07-18T10:05",
  }

  it("accepts a complete form", () => {
    expect(validateReportForm(valid)).toEqual({})
  })

  it("requires a title", () => {
    expect(validateReportForm({ ...valid, title: "  " }).title).toBe(
      "Enter a title"
    )
    expect(validateReportForm({ ...valid, title: "a".repeat(161) }).title).toBe(
      "Use 160 characters or fewer"
    )
  })

  it("requires the initial update only when asked", () => {
    expect(validateReportForm({ ...valid, markdown: "" }).markdown).toBe(
      "Write the first update"
    )
    expect(
      validateReportForm({ ...valid, markdown: "", requireUpdate: false })
        .markdown
    ).toBeUndefined()
  })

  it("checks the maintenance window ordering", () => {
    const maintenance = {
      ...valid,
      type: "maintenance" as const,
      endsAt: "2026-07-18T09:00",
    }
    expect(validateReportForm(maintenance).endsAt).toBe(
      "End must be after start"
    )
    expect(
      validateReportForm({ ...maintenance, endsAt: "2026-07-18T11:00" }).endsAt
    ).toBeUndefined()
    expect(
      validateReportForm({ ...maintenance, endsAt: "" }).endsAt
    ).toBeUndefined()
  })

  it("requires a parseable start", () => {
    expect(validateReportForm({ ...valid, startsAt: "" }).startsAt).toBe(
      "Enter a start time"
    )
  })
})

describe("impactOptions", () => {
  it("scopes impact choices to the report type", () => {
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
})

describe("datetime helpers", () => {
  it("round-trips through the datetime-local format", () => {
    const iso = "2026-07-18T10:30:00.000Z"
    const local = toDatetimeLocal(iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromDatetimeLocal(local)).toBe(iso)
  })

  it("returns null for unparseable input", () => {
    expect(fromDatetimeLocal("")).toBeNull()
    expect(fromDatetimeLocal("not-a-date")).toBeNull()
  })
})

describe("formatUpdateCount", () => {
  it("pluralizes", () => {
    expect(formatUpdateCount(1)).toBe("1 update")
    expect(formatUpdateCount(3)).toBe("3 updates")
  })
})
