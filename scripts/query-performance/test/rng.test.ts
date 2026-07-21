import { describe, expect, it } from "vitest"

import { intBetween, mulberry32, pick } from "../src/rng"

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const first = mulberry32(42)
    const second = mulberry32(42)
    const firstValues = Array.from({ length: 5 }, () => first())
    const secondValues = Array.from({ length: 5 }, () => second())
    expect(firstValues).toEqual(secondValues)
  })

  it("produces values in [0, 1)", () => {
    const rand = mulberry32(1)
    for (let index = 0; index < 100; index += 1) {
      const value = rand()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it("diverges for different seeds", () => {
    const a = mulberry32(1)()
    const b = mulberry32(2)()
    expect(a).not.toBe(b)
  })
})

describe("intBetween", () => {
  it("stays within the inclusive bounds", () => {
    const rand = mulberry32(7)
    for (let index = 0; index < 200; index += 1) {
      const value = intBetween(rand, 3, 8)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(8)
    }
  })
})

describe("pick", () => {
  it("only returns items from the input array", () => {
    const rand = mulberry32(9)
    const items = ["a", "b", "c"] as const
    for (let index = 0; index < 50; index += 1) {
      expect(items).toContain(pick(rand, items))
    }
  })

  it("throws on an empty array", () => {
    const rand = mulberry32(9)
    expect(() => pick(rand, [])).toThrow(RangeError)
  })
})
