import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  clientIpFromHeaders,
  firstForwardedIp,
  validClientIpFromHeaders,
} from "./client-ip"

describe("firstForwardedIp", () => {
  it("takes only the first hop and trims it", () => {
    expect(firstForwardedIp("203.0.113.7, 10.0.0.1, 172.16.0.1")).toBe(
      "203.0.113.7"
    )
    expect(firstForwardedIp(" 203.0.113.7 ")).toBe("203.0.113.7")
    expect(firstForwardedIp(null)).toBeNull()
    expect(firstForwardedIp("")).toBeNull()
  })
})

describe("clientIpFromHeaders", () => {
  it("prefers the platform-set x-real-ip over the spoofable forwarded chain", () => {
    const headers = new Headers({
      "x-real-ip": "198.51.100.9",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    })
    expect(clientIpFromHeaders(headers)).toBe("198.51.100.9")
  })

  it("falls back to the first forwarded hop when x-real-ip is absent or blank", () => {
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })
      )
    ).toBe("203.0.113.7")
    expect(
      clientIpFromHeaders(
        new Headers({ "x-real-ip": "  ", "x-forwarded-for": "203.0.113.7" })
      )
    ).toBe("203.0.113.7")
    expect(clientIpFromHeaders(new Headers())).toBeNull()
  })
})

describe("validClientIpFromHeaders", () => {
  it("returns the address only when it is a valid IPv4 or IPv6 literal", () => {
    expect(
      validClientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.9" }))
    ).toBe("198.51.100.9")
    expect(
      validClientIpFromHeaders(
        new Headers({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" })
      )
    ).toBe("2001:db8::1")
  })

  it("returns null when the extracted value is not a valid IP", () => {
    expect(
      validClientIpFromHeaders(new Headers({ "x-real-ip": "not-an-ip" }))
    ).toBeNull()
    expect(
      validClientIpFromHeaders(
        new Headers({ "x-forwarded-for": "example.com" })
      )
    ).toBeNull()
    expect(validClientIpFromHeaders(new Headers())).toBeNull()
  })

  it("validates the x-real-ip winner rather than the forwarded fallback", () => {
    const headers = new Headers({
      "x-real-ip": "bogus",
      "x-forwarded-for": "203.0.113.7",
    })
    expect(validClientIpFromHeaders(headers)).toBeNull()
  })
})
