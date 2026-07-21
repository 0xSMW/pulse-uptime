import { describe, expect, it } from "vitest"

import { parseUserCodeInput } from "./user-code"

describe("parseUserCodeInput", () => {
  it.each([
    ["h7kd-pq4m", "H7KD-PQ4M"],
    ["H7KD PQ4M", "H7KD-PQ4M"],
    ["H7KDPQ4M", "H7KD-PQ4M"],
    [
      "https://pulse.example.com/cli/authorize?user_code=h7kd-pq4m",
      "H7KD-PQ4M",
    ],
  ])("normalizes %s", (value, expected) => {
    expect(parseUserCodeInput(value)).toEqual({ ok: true, code: expected })
  })

  it.each([
    "",
    "H7KD",
    "https://pulse.example.com/settings?user_code=H7KD-PQ4M",
    "https://pulse.example.com/cli/authorize",
  ])("rejects %s", (value) => {
    expect(parseUserCodeInput(value).ok).toBe(false)
  })
})
