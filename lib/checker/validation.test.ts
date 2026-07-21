import { describe, expect, it } from "vitest"

import {
  MonitorValidationError,
  parsePublicHttpUrl,
  validateCheckTarget,
} from "./validation"

const target = {
  url: "https://example.com/health",
  method: "GET",
  timeoutMs: 8000,
  expectedStatus: { minimum: 200, maximum: 299 },
}

describe("URL validation", () => {
  it.each([
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com:8443",
    "http://example.com:443",
    "https://example.com:80",
    "http://localhost",
    "http://127.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://203.0.113.10/health",
    "http://[::1]",
    "relative/path",
  ])("rejects unsafe or unsupported URL %s", (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow()
  })

  it.each([
    "http://example.com",
    "https://example.com:443/path",
    "http://8.8.8.8:80",
  ])("accepts valid URL %s", (url) =>
    expect(parsePublicHttpUrl(url)).toBeInstanceOf(URL)
  )
})

describe("check target validation", () => {
  it("accepts a complete check target", () => {
    expect(validateCheckTarget(target)).toEqual(target)
  })

  it.each([
    ["bad method", { method: "POST" }],
    ["short timeout", { timeoutMs: 999 }],
    [
      "reversed status range",
      { expectedStatus: { minimum: 500, maximum: 200 } },
    ],
  ])("rejects %s", (_label, change) => {
    expect(() => validateCheckTarget({ ...target, ...change })).toThrow(
      MonitorValidationError
    )
  })

  it("strictly rejects unknown configuration fields", () => {
    expect(() => validateCheckTarget({ ...target, extra: true })).toThrow(
      MonitorValidationError
    )
  })
})
