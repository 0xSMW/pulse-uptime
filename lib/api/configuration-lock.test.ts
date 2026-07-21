import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import {
  CONFIGURATION_LOCK_KEY,
  type ConfigurationLockExecutor,
  lockConfiguration,
  lockedNow,
} from "./configuration-lock"

function sqlText(query: SQL): string {
  return query.queryChunks
    .map((chunk) => {
      if (chunk === undefined) {
        return ""
      }
      if (typeof chunk === "string") {
        return chunk
      }
      if ("value" in chunk && Array.isArray(chunk.value)) {
        return chunk.value.join("")
      }
      return ""
    })
    .join("")
}

describe("configuration advisory lock", () => {
  it("exports the fixed configuration lock namespace", () => {
    expect(CONFIGURATION_LOCK_KEY).toBe("pulse:configuration")
  })

  it("acquires pg_advisory_xact_lock on hashtext of the configuration key", async () => {
    const execute = vi.fn(async (_query: SQL) => undefined)
    const tx: ConfigurationLockExecutor = { execute }
    await lockConfiguration(tx)

    expect(execute).toHaveBeenCalledOnce()
    const query = execute.mock.calls[0]?.[0]
    expect(query).toBeDefined()
    const text = sqlText(query!)
    expect(text).toContain("pg_advisory_xact_lock")
    expect(text).toContain("hashtext")
    // Key is a bound parameter so the constant stays single-sourced.
    expect(
      query!.queryChunks.some((chunk) => chunk === CONFIGURATION_LOCK_KEY)
    ).toBe(true)
  })

  it("runs the lock SQL on the provided transaction executor only", async () => {
    const execute = vi.fn(async (_query: SQL) => undefined)
    await lockConfiguration({ execute })
    expect(execute).toHaveBeenCalledOnce()
  })
})

describe("lockedNow", () => {
  it("parses the numeric epoch string the database returns", async () => {
    // Row shape mirrors the raw postgres-js execute result for the numeric
    // cast, a decimal string keyed epoch_ms.
    const execute = vi.fn(async (_query: SQL) => [
      { epoch_ms: "1753093138724.123000" },
    ])
    const stamped = await lockedNow({ execute } as ConfigurationLockExecutor)
    expect(stamped.getTime()).toBe(1_753_093_138_724)
    const text = sqlText(execute.mock.calls[0]?.[0] as SQL)
    expect(text).toContain("clock_timestamp")
    expect(text).toContain("epoch_ms")
  })

  it("throws when the clock query returns no row", async () => {
    const execute = vi.fn(async (_query: SQL) => [])
    await expect(
      lockedNow({ execute } as ConfigurationLockExecutor)
    ).rejects.toThrow("clock_timestamp query returned no row")
  })
})
