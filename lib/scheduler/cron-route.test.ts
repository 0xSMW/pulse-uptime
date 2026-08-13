import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { CRON_RESPONSE_HEADERS } from "./authentication"
import { runCronRoute } from "./cron-route"

const secret = "cron-secret"

function authorizedRequest(): Request {
  return new Request("https://pulse.test/api/cron/example", {
    headers: { authorization: `Bearer ${secret}` },
  })
}

function loggedObject(spy: ReturnType<typeof vi.spyOn>, call: number) {
  const value = spy.mock.calls[call]?.[0]
  expect(typeof value).toBe("string")
  return JSON.parse(String(value)) as Record<string, unknown>
}

describe("runCronRoute", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = secret
    process.env.PULSE_RELEASE_ID = "release-123"
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CRON_SECRET
    delete process.env.PULSE_RELEASE_ID
  })

  it("rejects unauthorized requests before running or logging", async () => {
    const run = vi.fn(async () => ({ status: "completed", runId: "run-1" }))
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await runCronRoute(
      new Request("https://pulse.test/api/cron/example"),
      { jobName: "example", run }
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" })
    expect(response.headers.get("cache-control")).toBe(
      CRON_RESPONSE_HEADERS["cache-control"]
    )
    expect(response.headers.get("content-type")).toBe(
      CRON_RESPONSE_HEADERS["content-type"]
    )
    expect(run).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it("returns and logs a completed result", async () => {
    const result = {
      status: "completed",
      runId: "run-1",
      counts: { successCount: 2 },
    }
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1250)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await runCronRoute(authorizedRequest(), {
      jobName: "example",
      run: async () => result,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(result)
    expect(info).toHaveBeenCalledTimes(2)
    expect(loggedObject(info, 0)).toEqual({
      event: "cron.started",
      jobName: "example",
      releaseId: "release-123",
    })
    expect(loggedObject(info, 1)).toEqual({
      event: "cron.completed",
      jobName: "example",
      releaseId: "release-123",
      status: "completed",
      runId: "run-1",
      durationMs: 250,
    })
    expect(error).not.toHaveBeenCalled()
  })

  it("omits runId when the lease is held", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(2000).mockReturnValueOnce(2015)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await runCronRoute(authorizedRequest(), {
      jobName: "example",
      run: async () => ({ status: "lease-held" }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "lease-held" })
    expect(loggedObject(info, 1)).toEqual({
      event: "cron.completed",
      jobName: "example",
      releaseId: "release-123",
      status: "lease-held",
      durationMs: 15,
    })
    expect(error).not.toHaveBeenCalled()
  })

  it("returns 500 and logs the failure error code", async () => {
    const result = {
      status: "failed",
      runId: "run-failed",
      error: "database_unavailable",
    }
    vi.spyOn(Date, "now").mockReturnValueOnce(3000).mockReturnValueOnce(3040)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await runCronRoute(authorizedRequest(), {
      jobName: "example",
      run: async () => result,
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(result)
    expect(info).toHaveBeenCalledTimes(1)
    expect(loggedObject(error, 0)).toEqual({
      event: "cron.failed",
      jobName: "example",
      releaseId: "release-123",
      status: "failed",
      errorCode: "database_unavailable",
      runId: "run-failed",
      durationMs: 40,
    })
  })

  it("propagates thrown runner errors after the start log", async () => {
    const failure = new Error("runner exploded")
    vi.spyOn(Date, "now").mockReturnValue(4000)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(
      runCronRoute(authorizedRequest(), {
        jobName: "example",
        run: async () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)

    expect(info).toHaveBeenCalledTimes(1)
    expect(loggedObject(info, 0)).toEqual({
      event: "cron.started",
      jobName: "example",
      releaseId: "release-123",
    })
    expect(error).not.toHaveBeenCalled()
  })
})
