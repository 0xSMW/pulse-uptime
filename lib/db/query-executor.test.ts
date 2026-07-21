import { runInNewContext } from "node:vm"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { unsafe, reserve, reservedUnsafe, release } = vi.hoisted(() => ({
  unsafe: vi.fn(),
  reserve: vi.fn(),
  reservedUnsafe: vi.fn(),
  release: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({ sql: { unsafe, reserve } }))
vi.mock("server-only", () => ({}))

import { queryExecutor } from "./query-executor"

describe("queryExecutor", () => {
  beforeEach(() => {
    unsafe.mockReset()
    reserve.mockReset()
    reservedUnsafe.mockReset()
    release.mockReset()
    reserve.mockResolvedValue({ unsafe: reservedUnsafe, release })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs query through sql.unsafe with portable Date values", async () => {
    const foreignDate = runInNewContext("new Date('2026-07-18T07:00:00Z')")
    unsafe.mockResolvedValue([{ id: "row-1" }])

    const rows = await queryExecutor.query<{ id: string }>(
      "select $1::timestamptz as id",
      [foreignDate, "monitor-check"]
    )

    expect(rows).toEqual([{ id: "row-1" }])
    expect(unsafe).toHaveBeenCalledWith("select $1::timestamptz as id", [
      "2026-07-18T07:00:00.000Z",
      "monitor-check",
    ])
  })

  it("applies statement_timeout on one connection then runs work query", async () => {
    reservedUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ affected: 4 }])
      .mockResolvedValueOnce([])

    const result = await queryExecutor.withStatementTimeout(1500.9, (query) =>
      query<{ affected: number }>("delete from checks where true", [
        new Date("2026-06-18T00:00:00Z"),
      ])
    )

    expect(result).toEqual([{ affected: 4 }])
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reservedUnsafe).toHaveBeenNthCalledWith(1, "begin", [])
    expect(reservedUnsafe.mock.calls[1]?.[0]).toBe(
      `select set_config('statement_timeout', $1, true)`
    )
    const configuredTimeout = Number(reservedUnsafe.mock.calls[1]?.[1]?.[0])
    expect(configuredTimeout).toBeGreaterThan(0)
    expect(configuredTimeout).toBeLessThanOrEqual(1500)
    expect(reservedUnsafe).toHaveBeenNthCalledWith(
      3,
      "delete from checks where true",
      ["2026-06-18T00:00:00.000Z"]
    )
    expect(reservedUnsafe).toHaveBeenNthCalledWith(4, "commit", [])
    expect(release).toHaveBeenCalledOnce()
  })

  it("bounds connection acquisition and releases a late reservation", async () => {
    vi.useFakeTimers()
    let resolveReservation!: (connection: {
      unsafe: typeof reservedUnsafe
      release: typeof release
    }) => void
    reserve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReservation = resolve
      })
    )

    const result = queryExecutor.withStatementTimeout(2500, async () => null)
    const rejection = expect(result).rejects.toMatchObject({ code: "57014" })

    await vi.advanceTimersByTimeAsync(2500)
    await rejection
    expect(reservedUnsafe).not.toHaveBeenCalled()

    resolveReservation({ unsafe: reservedUnsafe, release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(reservedUnsafe).not.toHaveBeenCalled()
  })

  it("subtracts connection acquisition time from statement_timeout", async () => {
    vi.useFakeTimers()
    let resolveReservation!: (connection: {
      unsafe: typeof reservedUnsafe
      release: typeof release
    }) => void
    reserve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReservation = resolve
      })
    )
    reservedUnsafe.mockResolvedValue([])

    const result = queryExecutor.withStatementTimeout(1500, async () => null)
    await vi.advanceTimersByTimeAsync(600)
    resolveReservation({ unsafe: reservedUnsafe, release })
    await result

    expect(reservedUnsafe).toHaveBeenNthCalledWith(
      2,
      `select set_config('statement_timeout', $1, true)`,
      ["900"]
    )
  })

  it("cancels active SQL when the wall-clock deadline expires", async () => {
    vi.useFakeTimers()
    let rejectQuery!: (error: Error) => void
    const pending = Object.assign(
      new Promise<never>((_, reject) => {
        rejectQuery = reject
      }),
      {
        cancel: vi.fn(() => {
          rejectQuery(Object.assign(new Error("cancelled"), { code: "57014" }))
        }),
      }
    )
    reservedUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce([])

    const result = queryExecutor.withStatementTimeout(1000, (query) =>
      query("select pg_sleep(10)", [])
    )
    const rejection = expect(result).rejects.toMatchObject({ code: "57014" })
    await vi.waitFor(() => expect(reservedUnsafe).toHaveBeenCalledTimes(3))

    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())

    expect(pending.cancel).toHaveBeenCalledOnce()
    expect(reservedUnsafe).toHaveBeenNthCalledWith(4, "rollback", [])
  })

  it("clamps non-positive statement_timeout to 1 ms", async () => {
    // Fake timers keep the 1 ms wall clock deadline from expiring mid test
    // on a slow runner, the clamp is observable without racing it.
    vi.useFakeTimers()
    reservedUnsafe.mockResolvedValue([])

    await queryExecutor.withStatementTimeout(0, async (query) => {
      await query("select 1", [])
      return null
    })

    expect(reservedUnsafe.mock.calls[1]?.[1]).toEqual(["1"])
  })
})
