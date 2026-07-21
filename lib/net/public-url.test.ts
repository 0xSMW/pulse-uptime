import { describe, expect, it } from "vitest"

import { isPublicHttpUrl } from "./public-url"

describe("isPublicHttpUrl", () => {
  it.each([
    "https://example.com/health",
    "http://example.com",
    "https://example.com:443/path",
    "http://example.com:80/path",
    "http://8.8.8.8/health",
  ])("accepts public destination %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(true)
  })

  it.each([
    "ftp://example.com",
    "relative/path",
    "https://user:secret@example.com",
    "http://localhost/health",
    "http://api.localhost/health",
    "http://203.0.113.10/health",
    "http://192.0.0.1/health",
    "http://192.88.99.1/health",
    "http://198.18.0.1/health",
    "http://198.51.100.1/health",
    "http://100.64.0.1/health",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[::ffff:192.168.0.1]/health",
    "http://[2001:db8::1]/health",
  ])("rejects reserved or unsupported destination %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false)
  })

  it.each([
    ["disallowed port", "https://example.com:8443"],
    ["http on the https port", "http://example.com:443"],
    ["https on the http port", "https://example.com:80"],
  ])("enforces the port policy: %s", (_label, url) => {
    expect(isPublicHttpUrl(url)).toBe(false)
  })
})
