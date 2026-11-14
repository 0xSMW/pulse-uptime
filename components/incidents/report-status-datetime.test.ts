import { describe, expect, it } from "vitest"

import {
  datetimeLocalError,
  fromDatetimeLocal,
  isBeforeStart,
  resolveDatetimeLocal,
  toDatetimeLocal,
  validateReportForm,
} from "./report-status"

const NEW_YORK = "America/New_York"
const BANGKOK = "Asia/Bangkok"

describe("report datetime helpers with a display zone", () => {
  it("formats and parses in the given zone", () => {
    const iso = "2026-11-13T07:05:00.000Z"
    expect(toDatetimeLocal(iso, BANGKOK)).toBe("2026-11-13T14:05")
    expect(toDatetimeLocal(iso, NEW_YORK)).toBe("2026-11-13T02:05")
    expect(fromDatetimeLocal("2026-11-13T14:05", BANGKOK)).toBe(iso)
    expect(fromDatetimeLocal("2026-11-13T02:05", NEW_YORK)).toBe(iso)
  })

  it("rejects skipped and repeated wall times", () => {
    expect(fromDatetimeLocal("2026-03-08T02:30", NEW_YORK)).toBeNull()
    expect(fromDatetimeLocal("2026-11-01T01:30", NEW_YORK)).toBeNull()
    expect(fromDatetimeLocal("", NEW_YORK)).toBeNull()
    expect(datetimeLocalError("2026-03-08T02:30", NEW_YORK)).toBe(
      "Time skipped at clock change"
    )
    expect(datetimeLocalError("2026-11-01T01:30", NEW_YORK)).toBe(
      "Time repeats at clock change"
    )
    expect(datetimeLocalError("2026-11-01T02:30", NEW_YORK)).toBeUndefined()
  })

  it("keeps an untouched value at its loaded instant", () => {
    // Second occurrence of 01:30 on fall-back day, with seconds.
    const original = "2026-11-01T06:30:42.000Z"
    const local = toDatetimeLocal(original, NEW_YORK)
    expect(local).toBe("2026-11-01T01:30")
    expect(resolveDatetimeLocal(local, NEW_YORK, original)).toBe(original)
    expect(datetimeLocalError(local, NEW_YORK, original)).toBeUndefined()
    expect(resolveDatetimeLocal("2026-11-01T03:00", NEW_YORK, original)).toBe(
      "2026-11-01T08:00:00.000Z"
    )
  })

  it("keeps the browser-local fallback without a zone", () => {
    const iso = "2026-07-18T10:30:00.000Z"
    expect(fromDatetimeLocal(toDatetimeLocal(iso))).toBe(iso)
    expect(toDatetimeLocal(iso)).toBe(
      toDatetimeLocal(iso, Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
  })
})

describe("isBeforeStart with a display zone", () => {
  it("compares in the given zone, not the browser zone", () => {
    // 09:00 Bangkok is 02:00 UTC, 22:00 New York the prior day.
    expect(isBeforeStart("2026-07-18T08:59", "2026-07-18T09:00", BANGKOK)).toBe(
      true
    )
    expect(isBeforeStart("2026-07-18T09:00", "2026-07-18T09:00", BANGKOK)).toBe(
      false
    )
  })

  it("uses loaded instants for untouched repeated times", () => {
    const startsAt = "2026-11-01T06:00:00.000Z" // 01:00 EST, second pass
    const publishedAt = "2026-11-01T05:45:00.000Z" // 01:45 EDT, first pass
    const startsLocal = toDatetimeLocal(startsAt, NEW_YORK)
    const publishedLocal = toDatetimeLocal(publishedAt, NEW_YORK)
    expect(isBeforeStart(publishedLocal, startsLocal, NEW_YORK)).toBe(false)
    expect(
      isBeforeStart(publishedLocal, startsLocal, NEW_YORK, {
        startsAt,
        publishedAt,
      })
    ).toBe(true)
  })
})

describe("validateReportForm with a display zone", () => {
  const base = {
    title: "API outage",
    startsAt: "2026-11-01T00:30",
    endsAt: "",
    type: "incident" as const,
    requireUpdate: true,
    markdown: "Investigating",
    publishedAt: "2026-11-01T00:45",
  }

  it("accepts valid wall times in each zone", () => {
    for (const timeZone of ["UTC", NEW_YORK, BANGKOK]) {
      expect(validateReportForm({ ...base, timeZone })).toEqual({})
    }
  })

  it("flags newly typed skipped or repeated times", () => {
    const errors = validateReportForm({
      ...base,
      type: "maintenance",
      startsAt: "2026-03-08T02:15",
      endsAt: "2026-11-01T01:15",
      publishedAt: "2026-11-01T01:45",
      timeZone: NEW_YORK,
    })
    expect(errors.startsAt).toBe("Time skipped at clock change")
    expect(errors.endsAt).toBe("Time repeats at clock change")
    expect(errors.publishedAt).toBe("Time repeats at clock change")
  })

  it("accepts untouched repeated times from the loaded report", () => {
    const startsAt = "2026-11-01T05:15:00.000Z" // 01:15 EDT
    const endsAt = "2026-11-01T06:45:00.000Z" // 01:45 EST
    const errors = validateReportForm({
      ...base,
      type: "maintenance",
      startsAt: toDatetimeLocal(startsAt, NEW_YORK),
      endsAt: toDatetimeLocal(endsAt, NEW_YORK),
      requireUpdate: false,
      timeZone: NEW_YORK,
      originals: { startsAt, endsAt },
    })
    expect(errors).toEqual({})
  })

  it("orders end after start by instant in the zone", () => {
    expect(
      validateReportForm({
        ...base,
        type: "maintenance",
        startsAt: "2026-07-18T10:00",
        endsAt: "2026-07-18T09:00",
        timeZone: BANGKOK,
      }).endsAt
    ).toBe("End must be after start")
  })
})
