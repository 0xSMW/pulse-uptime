import { describe, expect, it } from "vitest"

import { isUuid } from "./uuid"

describe("isUuid", () => {
  it("accepts app-generated v4 and v5 UUIDs", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true)
    expect(isUuid(crypto.randomUUID())).toBe(true)
    // v5-shaped, variant a.
    expect(isUuid("21f7f8de-8051-5b89-a3b9-1a1a1a1a1a1a")).toBe(true)
  })

  it("is case insensitive", () => {
    expect(isUuid("AABBCCDD-1122-4E56-9F00-112233445566")).toBe(true)
  })

  it("rejects malformed input the loose 8-4-4-4-12 shape allowed", () => {
    // version nibble 0 is out of the strict 1-5 range.
    expect(isUuid("00000000-0000-0000-8000-000000000001")).toBe(false)
    // variant nibble 7 is out of the strict 8-b range.
    expect(isUuid("00000000-0000-4000-7000-000000000001")).toBe(false)
    // version nibble 6 is out of the strict 1-5 range.
    expect(isUuid("00000000-0000-6000-8000-000000000001")).toBe(false)
  })

  it("rejects non-hex, wrong length, and surrounding whitespace", () => {
    expect(isUuid("not-a-uuid")).toBe(false)
    expect(isUuid("00000000-0000-4000-8000-00000000000")).toBe(false)
    expect(isUuid(" 00000000-0000-4000-8000-000000000001")).toBe(false)
    expect(isUuid("")).toBe(false)
  })
})
