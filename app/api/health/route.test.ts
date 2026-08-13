import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { withStatementTimeout } = vi.hoisted(() => ({
  withStatementTimeout: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/query-executor", () => ({
  queryExecutor: { withStatementTimeout },
}))

import { GET, resetHealthAdmissionForTests } from "./route"

function request(ip = "203.0.113.10"): Request {
  return new Request("https://pulse.example/api/health", {
    headers: { "x-real-ip": ip },
  })
}

describe("GET /api/health", () => {
  beforeEach(() => {
    withStatementTimeout.mockReset()
    resetHealthAdmissionForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns app and database ok with no-store when the probe succeeds", async () => {
    withStatementTimeout.mockImplementation(
      async (
        _timeoutMs: number,
        work: (query: typeof vi.fn) => Promise<unknown>
      ) => {
        const query = vi.fn().mockResolvedValue([{ "?column?": 1 }])
        return work(query)
      }
    )

    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "ok",
    })
    expect(withStatementTimeout).toHaveBeenCalledWith(
      2500,
      expect.any(Function)
    )
  })

  it("marks the database unreachable when the bounded query fails", async () => {
    withStatementTimeout.mockRejectedValue(
      new Error("canceling statement due to statement timeout")
    )

    const response = await GET(request())
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "unreachable",
    })
  })

  it("settles the statement-timeout-bounded query before the response returns", async () => {
    let workSettled = false
    withStatementTimeout.mockImplementation(
      async (
        timeoutMs: number,
        work: (query: typeof vi.fn) => Promise<unknown>
      ) => {
        expect(timeoutMs).toBe(2500)
        const query = vi.fn().mockImplementation(async () => {
          await Promise.resolve()
          workSettled = true
          return [{ "?column?": 1 }]
        })
        const result = await work(query)
        expect(workSettled).toBe(true)
        return result
      }
    )

    const response = await GET(request())
    expect(workSettled).toBe(true)
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "ok",
    })
  })

  it("coalesces concurrent public probes into one database query", async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    withStatementTimeout.mockImplementation(async (_timeoutMs, work) => {
      await barrier
      return work(vi.fn().mockResolvedValue([{ "?column?": 1 }]))
    })

    const responses = Array.from({ length: 20 }, () => GET(request()))
    await Promise.resolve()
    expect(withStatementTimeout).toHaveBeenCalledTimes(1)

    release()
    const settled = await Promise.all(responses)
    expect(settled.every((response) => response.status === 200)).toBe(true)
    expect(withStatementTimeout).toHaveBeenCalledTimes(1)
  })

  it("blocks an abusive source before additional database probes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"))
    withStatementTimeout.mockImplementation(async (_timeoutMs, work) =>
      work(vi.fn().mockResolvedValue([{ "?column?": 1 }]))
    )

    const responses: Response[] = []
    for (let index = 0; index < 60; index += 1) {
      responses.push(await GET(request()))
    }
    vi.setSystemTime(new Date("2026-08-13T00:00:01.001Z"))
    responses.push(await GET(request()))

    expect(
      responses.slice(0, 60).every((response) => response.status === 200)
    ).toBe(true)
    expect(responses[60]?.status).toBe(429)
    expect(responses[60]?.headers.get("retry-after")).toBeTruthy()
    expect(withStatementTimeout).toHaveBeenCalledTimes(1)
  })
})
