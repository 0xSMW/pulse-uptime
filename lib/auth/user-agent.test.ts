import { describe, expect, it } from "vitest"

import { parseUserAgent, UNKNOWN_BROWSER, UNKNOWN_OS } from "./user-agent"

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0"
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87"
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
const PULSECTL = "pulsectl/1.4.0 (darwin; arm64)"

describe("parseUserAgent", () => {
  it("identifies Chrome with its major version", () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual({
      browser: "Chrome 126",
      os: "macOS",
    })
  })

  it("identifies Safari via its Version token, not the ubiquitous Safari suffix", () => {
    expect(parseUserAgent(SAFARI_MAC)).toEqual({
      browser: "Safari 17",
      os: "macOS",
    })
  })

  it("identifies Firefox on Windows", () => {
    expect(parseUserAgent(FIREFOX_WINDOWS)).toEqual({
      browser: "Firefox 127",
      os: "Windows",
    })
  })

  it("identifies Edge before its embedded Chrome token", () => {
    expect(parseUserAgent(EDGE_WINDOWS)).toEqual({
      browser: "Edge 126",
      os: "Windows",
    })
  })

  it("treats iPhones as iOS despite the like-Mac claim", () => {
    expect(parseUserAgent(SAFARI_IPHONE)).toEqual({
      browser: "Safari 17",
      os: "iOS",
    })
  })

  it("prefers Android over the Linux base token", () => {
    expect(parseUserAgent(CHROME_ANDROID)).toEqual({
      browser: "Chrome 126",
      os: "Android",
    })
  })

  it("identifies desktop Linux", () => {
    expect(parseUserAgent(CHROME_LINUX)).toEqual({
      browser: "Chrome 126",
      os: "Linux",
    })
  })

  it("identifies the pulsectl CLI and maps darwin to macOS", () => {
    expect(parseUserAgent(PULSECTL)).toEqual({
      browser: "pulsectl 1",
      os: "macOS",
    })
  })

  it("falls back to unknown for empty, missing, or unrecognized agents", () => {
    expect(parseUserAgent(null)).toEqual({
      browser: UNKNOWN_BROWSER,
      os: UNKNOWN_OS,
    })
    expect(parseUserAgent("   ")).toEqual({
      browser: UNKNOWN_BROWSER,
      os: UNKNOWN_OS,
    })
    expect(parseUserAgent("curl/8.6.0")).toEqual({
      browser: UNKNOWN_BROWSER,
      os: UNKNOWN_OS,
    })
  })
})
