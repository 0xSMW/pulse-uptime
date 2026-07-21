import type { SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import {
  CONFIGURATION_LOCK_KEY,
  type ConfigurationLockExecutor,
  lockConfiguration,
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
    expect(query!.queryChunks.some((chunk) => chunk === CONFIGURATION_LOCK_KEY)).toBe(
      true
    )
  })

  it("runs the lock SQL on the provided transaction executor only", async () => {
    const execute = vi.fn(async (_query: SQL) => undefined)
    await lockConfiguration({ execute })
    expect(execute).toHaveBeenCalledOnce()
  })
})
