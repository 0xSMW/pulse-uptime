import { describe, expect, it } from "vitest"

import {
  decodeCursor,
  decodeTimestampUuidCursor,
  encodeCursor,
  pageLimit,
} from "./pagination"

const VALID_UUID = "11111111-1111-4111-8111-111111111111"
const VALID_TS = "2026-07-18T00:00:00.000Z"

function craft(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

describe("API pagination", () => {
  it("round-trips opaque cursor tuples", () => {
    const cursor = encodeCursor({
      sort: VALID_TS,
      id: "item_1",
    })
    expect(cursor).not.toContain("2026-")
    expect(decodeCursor(cursor)).toEqual({
      sort: VALID_TS,
      id: "item_1",
    })
  })

  it("rejects malformed cursors and limits", () => {
    expect(decodeCursor("not-json")).toBeNull()
    expect(pageLimit(null)).toBe(50)
    expect(pageLimit("1")).toBe(1)
    expect(pageLimit("100")).toBe(100)
    expect(pageLimit("0")).toBeNull()
    expect(pageLimit("101")).toBeNull()
    expect(pageLimit("1.5")).toBeNull()
  })
})

describe("decodeTimestampUuidCursor", () => {
  it("returns null cursor when the param is absent", () => {
    expect(decodeTimestampUuidCursor(null)).toEqual({
      ok: true,
      cursor: null,
    })
  })

  it("accepts a valid timestamp+UUID tie-break cursor", () => {
    const encoded = encodeCursor({ sort: VALID_TS, id: VALID_UUID })
    expect(decodeTimestampUuidCursor(encoded)).toEqual({
      ok: true,
      cursor: { sort: new Date(VALID_TS), id: VALID_UUID },
    })
  })

  it("rejects empty present cursor, invalid base64url, and non-JSON payloads", () => {
    expect(decodeTimestampUuidCursor("")).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor("not-json")).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor("!!!")).toEqual({ ok: false })
    // Valid base64url of non-JSON text.
    expect(
      decodeTimestampUuidCursor(
        Buffer.from("not-json", "utf8").toString("base64url")
      )
    ).toEqual({ ok: false })
  })

  it("rejects wrong object shapes and wrong-typed fields", () => {
    expect(decodeTimestampUuidCursor(craft(null))).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor(craft([]))).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor(craft("string"))).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor(craft({ id: VALID_UUID }))).toEqual({
      ok: false,
    })
    expect(decodeTimestampUuidCursor(craft({ sort: VALID_TS }))).toEqual({
      ok: false,
    })
    expect(
      decodeTimestampUuidCursor(craft({ sort: 1, id: VALID_UUID }))
    ).toEqual({ ok: false })
    expect(decodeTimestampUuidCursor(craft({ sort: VALID_TS, id: 1 }))).toEqual(
      { ok: false }
    )
    expect(
      decodeTimestampUuidCursor(
        craft({ sort: VALID_TS, id: VALID_UUID, extra: { nested: true } })
      )
    ).toEqual({
      ok: true,
      cursor: { sort: new Date(VALID_TS), id: VALID_UUID },
    })
  })

  it("rejects malformed timestamps and impossible calendar dates", () => {
    expect(
      decodeTimestampUuidCursor(craft({ sort: "not-a-date", id: VALID_UUID }))
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(craft({ sort: "1", id: VALID_UUID }))
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(
        craft({ sort: "2026-07-18T00:00:00Z", id: VALID_UUID })
      )
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(
        craft({ sort: "2026-02-30T00:00:00.000Z", id: VALID_UUID })
      )
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(
        craft({ sort: "2026-13-01T00:00:00.000Z", id: VALID_UUID })
      )
    ).toEqual({ ok: false })
  })

  it("rejects non-UUID ids including SQL-shaped strings", () => {
    expect(
      decodeTimestampUuidCursor(craft({ sort: VALID_TS, id: "incident-1" }))
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(
        craft({ sort: VALID_TS, id: "'; drop table incidents;--" })
      )
    ).toEqual({ ok: false })
    expect(
      decodeTimestampUuidCursor(
        craft({
          sort: VALID_TS,
          id: "00000000-0000-0000-8000-000000000001",
        })
      )
    ).toEqual({ ok: false })
  })
})
