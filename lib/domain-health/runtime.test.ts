import { describe, expect, it, vi } from "vitest"

import type { CronRunStore } from "@/lib/scheduler/run-record"
import {
  DOMAIN_HEALTH_WORK_BUDGET_MS,
  runDomainHealthCoordinator,
} from "./runtime"
import type { DomainHealthRow } from "./store"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/query-executor", () => ({ queryExecutor: {} }))
vi.mock("@/lib/db/client", () => ({ db: {}, sql: {} }))
vi.mock("@/lib/api/config-mutation", () => ({
  requireAcceptedConfig: vi.fn(),
}))

function stores() {
  const runs: CronRunStore = {
    start: vi.fn(async () => true),
    complete: vi.fn(),
    fail: vi.fn(),
  }
  const leases = {
    acquire: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  }
  return { runs, leases }
}

const certFacts = {
  expiresAt: new Date("2026-10-12T00:00:00Z"),
  issuer: "Let's Encrypt",
}
const domainFacts = {
  expiresAt: new Date("2027-01-22T10:44:22Z"),
  registrar: "Namecheap, Inc.",
}

describe("runDomainHealthCoordinator", () => {
  it("dedupes lookups by hostname and apex and writes one row per monitor", async () => {
    const { runs, leases } = stores()
    const probeCert = vi.fn(async () => certFacts)
    const fetchDomain = vi.fn(async () => domainFacts)
    let persisted: DomainHealthRow[] = []

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [
        { id: "app", url: "https://app.klu.ai/health" },
        { id: "app-again", url: "https://app.klu.ai/other" },
        { id: "site", url: "https://klu.ai/" },
        { id: "plain", url: "http://plain.klu.ai/" },
      ],
      probeCert,
      fetchDomain,
      persist: async (rows) => {
        persisted = [...persisted, ...rows]
      },
    })

    // Two unique https hostnames, one apex across all four monitors.
    expect(probeCert).toHaveBeenCalledTimes(2)
    expect(probeCert).toHaveBeenCalledWith("app.klu.ai", 443)
    expect(probeCert).toHaveBeenCalledWith("klu.ai", 443)
    expect(fetchDomain).toHaveBeenCalledTimes(1)
    expect(fetchDomain).toHaveBeenCalledWith("klu.ai")

    expect(persisted).toHaveLength(4)
    const byId = new Map(persisted.map((row) => [row.monitorId, row]))
    expect(byId.get("app")).toMatchObject({
      hostname: "app.klu.ai",
      apexDomain: "klu.ai",
      certPort: 443,
      certExpiresAt: certFacts.expiresAt,
      certIssuer: "Let's Encrypt",
      domainExpiresAt: domainFacts.expiresAt,
      domainRegistrar: "Namecheap, Inc.",
    })
    // The http monitor carries domain facts but never a certificate probe.
    expect(byId.get("plain")).toMatchObject({
      hostname: "plain.klu.ai",
      certPort: null,
      certExpiresAt: null,
      certIssuer: null,
      domainExpiresAt: domainFacts.expiresAt,
    })

    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.counts).toEqual({
        monitorCount: 4,
        successCount: 4,
        failureCount: 0,
        skippedCount: 0,
      })
      expect(result.certProbes).toBe(2)
      expect(result.rdapLookups).toBe(1)
    }
  })

  it("persists failed new-port probes as null facts for that port", async () => {
    const { runs, leases } = stores()
    let persisted: DomainHealthRow[] = []
    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [
        { id: "app", url: "https://app.klu.ai:8443/" },
      ],
      probeCert: async () => ({ expiresAt: null, issuer: null }),
      fetchDomain: async () => ({ expiresAt: null, registrar: null }),
      persist: async (rows) => {
        persisted = [...persisted, ...rows]
      },
    })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      certPort: 8443,
      certExpiresAt: null,
      domainExpiresAt: null,
    })
    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.counts.successCount).toBe(0)
      expect(result.counts.failureCount).toBe(0)
    }
  })

  it("uses a custom port from the monitor URL", async () => {
    const { runs, leases } = stores()
    const probeCert = vi.fn(async () => certFacts)
    let persisted: DomainHealthRow[] = []
    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [
        { id: "alt", url: "https://alt.klu.ai:8443/health" },
      ],
      probeCert,
      fetchDomain: async () => domainFacts,
      persist: async (rows) => {
        persisted = [...persisted, ...rows]
      },
    })
    expect(probeCert).toHaveBeenCalledWith("alt.klu.ai", 8443)
    expect(persisted[0]?.certPort).toBe(8443)
  })

  it("admits both lookup classes before a slow class exhausts the window", async () => {
    const { runs, leases } = stores()
    const start = 1_000_000
    const late = start + DOMAIN_HEALTH_WORK_BUDGET_MS
    const nowMs = vi
      .fn(() => late)
      .mockImplementationOnce(() => start)
      .mockImplementationOnce(() => start)
      .mockImplementationOnce(() => start)
    const probeCert = vi.fn(async () => certFacts)
    const fetchDomain = vi.fn(async () => domainFacts)

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      nowMs,
      loadMonitors: async () => [
        { id: "one", url: "https://one.example.com" },
        { id: "two", url: "https://two.example.net" },
        { id: "three", url: "https://three.example.org" },
        { id: "four", url: "https://four.example.dev" },
      ],
      probeCert,
      fetchDomain,
      persist: async () => undefined,
    })

    expect(fetchDomain).toHaveBeenCalledTimes(1)
    expect(probeCert).toHaveBeenCalledTimes(1)
    expect(fetchDomain).toHaveBeenCalledWith("example.com")
    expect(probeCert).toHaveBeenCalledWith("one.example.com", 443)
    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.rdapLookups).toBe(1)
      expect(result.certProbes).toBe(1)
      expect(result.skippedLookups).toBe(6)
    }
  })

  it("skips lookups once the deadline has passed but still writes rows", async () => {
    const { runs, leases } = stores()
    const probeCert = vi.fn(async () => certFacts)
    let persisted: DomainHealthRow[] = []
    const start = 1_000_000
    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      // Every reading after the first is past the work budget.
      nowMs: vi
        .fn(() => start + 10_000_000)
        .mockImplementationOnce(() => start),
      loadMonitors: async () => [{ id: "app", url: "https://app.klu.ai/" }],
      probeCert,
      fetchDomain: async () => domainFacts,
      persist: async (rows) => {
        persisted = [...persisted, ...rows]
      },
    })
    expect(probeCert).not.toHaveBeenCalled()
    expect(persisted).toHaveLength(1)
    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.skippedLookups).toBeGreaterThan(0)
    }
  })
})
