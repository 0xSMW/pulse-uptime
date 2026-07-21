import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { DEFAULT_MONITOR_SETTINGS, type MonitoringConfig } from "@/lib/config"

import { writeMonitoringEdgeConfig } from "./edge-config-write"

const CONFIG: MonitoringConfig = {
  schemaVersion: 2,
  configVersion: 1,
  settings: { ...DEFAULT_MONITOR_SETTINGS },
  groups: [],
  monitors: [],
}

describe("writeMonitoringEdgeConfig", () => {
  beforeEach(() => {
    process.env.EDGE_CONFIG_ID = "ecfg_test"
    process.env.VERCEL_API_TOKEN = "test-token"
    delete process.env.VERCEL_TEAM_ID
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.EDGE_CONFIG_ID
    delete process.env.VERCEL_API_TOKEN
  })

  it("throws when the Edge Config credentials are missing", async () => {
    delete process.env.EDGE_CONFIG_ID
    await expect(writeMonitoringEdgeConfig(CONFIG)).rejects.toThrow()
  })

  it("PATCHes the monitoring item and returns the reported store version", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "x-vercel-edge-config-version": "42" },
      })
    )
    await expect(writeMonitoringEdgeConfig(CONFIG)).resolves.toBe(42)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain("/edge-config/ecfg_test/items")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ operation: "upsert", key: "monitoring", value: CONFIG }],
    })
  })

  it("returns null when no version header is present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )
    await expect(writeMonitoringEdgeConfig(CONFIG)).resolves.toBeNull()
  })

  it("throws on a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 500 })
    )
    await expect(writeMonitoringEdgeConfig(CONFIG)).rejects.toThrow()
  })
})
