import { runInNewContext } from "node:vm"

import { beforeEach, describe, expect, it, vi } from "vitest"

const { unsafe, begin } = vi.hoisted(() => ({
  unsafe: vi.fn(),
  begin: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({ sql: { unsafe, begin } }))
vi.mock("server-only", () => ({}))

import { queryExecutor } from "./query-executor"

describe("queryExecutor", () => {
  beforeEach(() => {
    unsafe.mockReset()
    begin.mockReset()
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
    const txUnsafe = vi.fn()
    txUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ affected: 4 }])
    begin.mockImplementation(
      async (fn: (tx: { unsafe: typeof txUnsafe }) => Promise<unknown>) =>
        fn({ unsafe: txUnsafe })
    )

    const result = await queryExecutor.withStatementTimeout(1500.9, (query) =>
      query<{ affected: number }>("delete from checks where true", [
        new Date("2026-06-18T00:00:00Z"),
      ])
    )

    expect(result).toEqual([{ affected: 4 }])
    expect(begin).toHaveBeenCalledTimes(1)
    expect(txUnsafe).toHaveBeenNthCalledWith(
      1,
      `select set_config('statement_timeout', $1, true)`,
      ["1500"]
    )
    expect(txUnsafe).toHaveBeenNthCalledWith(
      2,
      "delete from checks where true",
      ["2026-06-18T00:00:00.000Z"]
    )
  })

  it("clamps non-positive statement_timeout to 1 ms", async () => {
    const txUnsafe = vi.fn().mockResolvedValue([])
    begin.mockImplementation(
      async (fn: (tx: { unsafe: typeof txUnsafe }) => Promise<unknown>) =>
        fn({ unsafe: txUnsafe })
    )

    await queryExecutor.withStatementTimeout(0, async (query) => {
      await query("select 1", [])
      return null
    })

    expect(txUnsafe.mock.calls[0]?.[1]).toEqual(["1"])
  })
})
