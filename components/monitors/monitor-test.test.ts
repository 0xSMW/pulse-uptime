import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type MonitorTestResult,
  monitorTestOutcome,
  runMonitorTest,
} from "./monitor-test"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("monitorTestOutcome", () => {
  it("passes only an explicit success", () => {
    expect(monitorTestOutcome({ successful: true, statusCode: 200 })).toEqual({
      status: "success",
      message: "Monitor check passed",
    })
    expect(monitorTestOutcome(undefined).status).toBe("error")
    expect(
      monitorTestOutcome({
        successful: "true",
        statusCode: 200,
      } as unknown as MonitorTestResult).status
    ).toBe("error")
  })

  it("shows the HTTP status only for a status failure", () => {
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: 503,
        errorCode: "INVALID_STATUS",
        errorMessage: "Response status was outside the expected range",
      }).message
    ).toBe("Monitor check failed with HTTP 503")
  })

  it("reports a content mismatch behind an HTTP 200", () => {
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: 200,
        errorCode: "CONTENT_MISMATCH",
        errorMessage: "Expected text was not found in the response body",
      }).message
    ).toBe(
      "Monitor check failed with Expected text was not found in the response body"
    )
  })

  it("reports a body read timeout after the status arrived", () => {
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: 200,
        errorCode: "TIMEOUT",
        errorMessage: "Request timed out",
      }).message
    ).toBe("Monitor check failed with Request timed out")
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: 200,
        errorCode: "TOO_MANY_REDIRECTS",
        errorMessage: null,
      }).message
    ).toBe("Monitor check failed with TOO_MANY_REDIRECTS")
  })

  it("falls back from the message to the code, then Unknown failure", () => {
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: null,
        errorCode: "TIMEOUT",
      }).message
    ).toBe("Monitor check failed with TIMEOUT")
    expect(monitorTestOutcome({ successful: false }).message).toBe(
      "Monitor check failed with Unknown failure"
    )
  })

  it("fails closed on a malformed result", () => {
    const malformed = {
      successful: 1,
      statusCode: "503",
      errorCode: "INVALID_STATUS",
      errorMessage: { text: "oops" },
    } as unknown as MonitorTestResult
    expect(monitorTestOutcome(malformed)).toEqual({
      status: "error",
      message: "Monitor check failed with INVALID_STATUS",
    })
    expect(
      monitorTestOutcome({
        successful: false,
        statusCode: 200,
        errorCode: 42,
        errorMessage: "  ",
      } as unknown as MonitorTestResult).message
    ).toBe("Monitor check failed with Unknown failure")
    expect(
      monitorTestOutcome("ok" as unknown as MonitorTestResult).message
    ).toBe("Monitor check failed with Unknown failure")
  })
})

describe("runMonitorTest", () => {
  it("posts an idempotent test request and reads the probe result", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "key-1" })
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { data: { successful: false, statusCode: null, errorCode: "DNS" } },
          { status: 200 }
        )
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(runMonitorTest("api/prod")).resolves.toEqual({
      status: "error",
      message: "Monitor check failed with DNS",
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/v1/monitors/api%2Fprod/test")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("key-1")
  })

  it("surfaces the API error message", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "key-1" })
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: "RATE_LIMITED", message: "Too many requests" } },
            { status: 429 }
          )
        )
    )

    await expect(runMonitorTest("api")).resolves.toEqual({
      status: "error",
      message: "Too many requests",
    })
  })

  it("reports an unreachable server", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "key-1" })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")))

    await expect(runMonitorTest("api")).resolves.toEqual({
      status: "error",
      message: "Unable to reach the server. Try again.",
    })
  })
})
