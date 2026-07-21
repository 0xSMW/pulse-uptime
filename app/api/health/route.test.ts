import { beforeEach, describe, expect, it, vi } from "vitest"

const { withStatementTimeout } = vi.hoisted(() => ({
  withStatementTimeout: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/query-executor", () => ({
  queryExecutor: { withStatementTimeout },
}))

import { GET } from "./route"

describe("GET /api/health", () => {
  beforeEach(() => {
    withStatementTimeout.mockReset()
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

    const response = await GET()
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

    const response = await GET()
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

    const response = await GET()
    expect(workSettled).toBe(true)
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "ok",
    })
  })
})
