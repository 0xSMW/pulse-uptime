import { describe, expect, it } from "vitest"

import { formatDatetimeInput, parseDatetimeInput } from "./datetime-input"

describe("formatDatetimeInput", () => {
  it("renders the same instant in each display zone", () => {
    const iso = "2026-11-13T07:05:42.000Z"
    expect(formatDatetimeInput(iso, "UTC")).toBe("2026-11-13T07:05")
    expect(formatDatetimeInput(iso, "Asia/Bangkok")).toBe("2026-11-13T14:05")
    expect(formatDatetimeInput(iso, "America/New_York")).toBe(
      "2026-11-13T02:05"
    )
  })

  it("crosses the date line and renders midnight as 00", () => {
    expect(
      formatDatetimeInput("2026-11-13T17:00:00.000Z", "Asia/Bangkok")
    ).toBe("2026-11-14T00:00")
    expect(
      formatDatetimeInput("2026-11-13T10:30:00.000Z", "Pacific/Honolulu")
    ).toBe("2026-11-13T00:30")
  })

  it("returns an empty value for an unparseable instant", () => {
    expect(formatDatetimeInput("not-a-date", "UTC")).toBe("")
  })
})

describe("parseDatetimeInput", () => {
  it("reads the value in the given zone, not the process zone", () => {
    expect(parseDatetimeInput("2026-11-13T02:05", "America/New_York")).toEqual({
      status: "ok",
      iso: "2026-11-13T07:05:00.000Z",
    })
    expect(parseDatetimeInput("2026-11-13T14:05", "Asia/Bangkok")).toEqual({
      status: "ok",
      iso: "2026-11-13T07:05:00.000Z",
    })
    expect(parseDatetimeInput("2026-11-13T14:05:30", "UTC")).toEqual({
      status: "ok",
      iso: "2026-11-13T14:05:30.000Z",
    })
  })

  it("round-trips with formatting across zones", () => {
    const iso = "2026-07-18T10:30:00.000Z"
    for (const zone of [
      "UTC",
      "Asia/Bangkok",
      "America/New_York",
      "Europe/London",
      "Asia/Kolkata",
      "Australia/Lord_Howe",
    ]) {
      expect(parseDatetimeInput(formatDatetimeInput(iso, zone), zone)).toEqual({
        status: "ok",
        iso,
      })
    }
  })

  it("rejects a time skipped by the spring-forward jump", () => {
    expect(parseDatetimeInput("2026-03-08T02:30", "America/New_York")).toEqual({
      status: "nonexistent",
    })
    expect(parseDatetimeInput("2026-03-29T01:30", "Europe/London")).toEqual({
      status: "nonexistent",
    })
    expect(parseDatetimeInput("2026-03-08T03:00", "America/New_York")).toEqual({
      status: "ok",
      iso: "2026-03-08T07:00:00.000Z",
    })
  })

  it("reports both instants for a time repeated at fall-back", () => {
    expect(parseDatetimeInput("2026-11-01T01:30", "America/New_York")).toEqual({
      status: "ambiguous",
      earlier: "2026-11-01T05:30:00.000Z",
      later: "2026-11-01T06:30:00.000Z",
    })
    expect(parseDatetimeInput("2026-10-25T01:15", "Europe/London")).toEqual({
      status: "ambiguous",
      earlier: "2026-10-25T00:15:00.000Z",
      later: "2026-10-25T01:15:00.000Z",
    })
  })

  it("rejects malformed and out-of-range values", () => {
    for (const value of [
      "",
      "not-a-date",
      "2026-11-13",
      "2026-02-30T10:00",
      "2026-11-13T24:00",
      "2026-11-13T10:60",
      "2026-11-13T10:00Z",
    ]) {
      expect(parseDatetimeInput(value, "UTC")).toEqual({ status: "invalid" })
    }
  })
})
