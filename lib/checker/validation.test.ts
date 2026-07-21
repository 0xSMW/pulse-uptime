import { describe, expect, it } from "vitest"

import {
  MonitorValidationError,
  parsePublicHttpUrl,
  validateCheckTarget,
  validateMonitorConfig,
} from "./validation"

const monitor = {
  id: "api-main",
  name: "Main API",
  url: "https://example.com/health",
  enabled: true,
  group: null,
  method: "GET",
  intervalMinutes: 5,
  timeoutMs: 8000,
  expectedStatus: { minimum: 200, maximum: 299 },
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: ["ops@example.com"],
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

describe("monitor validation", () => {
  it("accepts a complete monitor", () => {
    expect(validateMonitorConfig(monitor)).toEqual(monitor)
  })

  it.each([
    ["bad slug", { id: "UPPER" }],
    ["bad method", { method: "POST" }],
    ["short timeout", { timeoutMs: 999 }],
    ["bad interval", { intervalMinutes: 2 }],
    [
      "reversed status range",
      { expectedStatus: { minimum: 500, maximum: 200 } },
    ],
    [
      "too many recipients",
      {
        recipients: Array.from(
          { length: 21 },
          (_, index) => `a${index}@example.com`
        ),
      },
    ],
  ])("rejects %s", (_label, change) => {
    expect(() => validateMonitorConfig({ ...monitor, ...change })).toThrow(
      MonitorValidationError
    )
  })

  it("strictly rejects unknown configuration fields", () => {
    expect(() =>
      validateMonitorConfig({ ...monitor, followRedirects: true })
    ).toThrow(MonitorValidationError)
    expect(() =>
      validateCheckTarget({
        url: monitor.url,
        method: monitor.method,
        timeoutMs: monitor.timeoutMs,
        expectedStatus: monitor.expectedStatus,
        extra: true,
      })
    ).toThrow(MonitorValidationError)
  })
})
