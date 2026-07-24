import { describe, expect, it, vi } from "vitest"

import type { CronRunStore } from "@/lib/scheduler/run-record"
import {
  DOMAIN_HEALTH_FRESHNESS_MS,
  DOMAIN_HEALTH_WORK_BUDGET_MS,
  runDomainHealthCoordinator,
  selectDueDomainHealthTargets,
} from "./runtime"
import type {
  DomainHealthAssetState,
  DomainHealthReconciliation,
} from "./store"
import { certificateAssetKey } from "./targets"

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

const emptyAssets = (): DomainHealthAssetState => ({
  domains: new Map(),
  certificates: new Map(),
})
const certFacts = {
  expiresAt: new Date("2026-10-12T00:00:00Z"),
  issuer: "Let's Encrypt",
}
const domainFacts = {
  expiresAt: new Date("2027-01-22T10:44:22Z"),
  registrar: "Namecheap, Inc.",
  outcome: "resolved" as const,
}

describe("runDomainHealthCoordinator", () => {
  it("refreshes an elapsed domain expiration not checked since it elapsed", () => {
    const now = new Date("2026-07-24T12:00:00Z")
    const expiresAt = new Date("2026-07-24T06:28:05Z")
    const checkedAt = new Date("2026-07-24T06:28:04Z")
    const due = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map(),
      },
      now
    )

    expect(due.apexDomains).toEqual(["thenootropics.guide"])
  })

  it("keeps post-expiry refreshes inside the freshness window", () => {
    const now = new Date("2026-07-24T12:00:00Z")
    const expiresAt = new Date("2026-07-24T06:28:05Z")
    const checkedAt = new Date("2026-07-24T06:28:06Z")
    const due = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map(),
      },
      now
    )

    expect(due.apexDomains).toEqual([])
  })

  it("treats the expiration check boundary as due", () => {
    const now = new Date("2026-07-24T12:00:00Z")
    const expiresAt = new Date("2026-07-24T06:28:05Z")
    const due = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt: expiresAt,
              lastSuccessAt: expiresAt,
              lastReferencedAt: expiresAt,
            },
          ],
        ]),
        certificates: new Map(),
      },
      now
    )

    expect(due.apexDomains).toEqual(["thenootropics.guide"])
  })

  it("keeps future domain expirations and certificates inside freshness", () => {
    const now = new Date("2026-07-24T12:00:00Z")
    const checkedAt = new Date(now.getTime() - 60_000)
    const due = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [{ hostname: "app.thenootropics.guide", port: 443 }],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt: new Date("2027-07-24T06:28:05Z"),
              registrar: "Porkbun LLC",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map([
          [
            certificateAssetKey("app.thenootropics.guide", 443),
            {
              hostname: "app.thenootropics.guide",
              port: 443,
              expiresAt: new Date("2026-07-24T06:28:05Z"),
              issuer: "Test CA",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
      },
      now
    )

    expect(due).toEqual({ apexDomains: [], certificates: [] })
  })

  it("records a failed elapsed-expiry catch-up so the next run can wait", async () => {
    const { runs, leases } = stores()
    const now = new Date("2026-07-24T12:00:00Z")
    const expiresAt = new Date("2026-07-24T06:28:05Z")
    const checkedAt = new Date("2026-07-24T06:28:04Z")
    let reconciliation: DomainHealthReconciliation | undefined

    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      now: () => now,
      loadMonitors: async () => [
        { id: "one", url: "http://app.thenootropics.guide" },
      ],
      loadAssets: async () => ({
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map(),
      }),
      probeCert: async () => {
        throw new Error("HTTP monitor has no certificate target")
      },
      fetchDomain: async () => {
        throw new Error("RDAP unavailable")
      },
      reconcile: async (input) => {
        reconciliation = input
      },
    })

    const refresh = reconciliation?.domains[0]
    expect(refresh).toMatchObject({
      apexDomain: "thenootropics.guide",
      expiresAt: null,
      registrar: null,
      checkedAt: now,
    })
    const nextDue = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt: refresh?.checkedAt ?? checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: now,
            },
          ],
        ]),
        certificates: new Map(),
      },
      new Date(now.getTime() + 10 * 60_000)
    )

    expect(nextDue.apexDomains).toEqual([])
  })

  it("reconciles a renewed expiration and leaves it fresh", async () => {
    const { runs, leases } = stores()
    const now = new Date("2026-07-24T12:00:00Z")
    const expiresAt = new Date("2026-07-24T06:28:05Z")
    const checkedAt = new Date("2026-07-24T06:28:04Z")
    const renewedAt = new Date("2027-07-24T06:28:05Z")
    let reconciliation: DomainHealthReconciliation | undefined

    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      now: () => now,
      loadMonitors: async () => [
        { id: "one", url: "http://app.thenootropics.guide" },
      ],
      loadAssets: async () => ({
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt,
              registrar: "Porkbun LLC",
              checkedAt,
              lastSuccessAt: checkedAt,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map(),
      }),
      probeCert: async () => {
        throw new Error("HTTP monitor has no certificate target")
      },
      fetchDomain: async () => ({
        expiresAt: renewedAt,
        registrar: "Porkbun LLC",
        outcome: "resolved" as const,
      }),
      reconcile: async (input) => {
        reconciliation = input
      },
    })

    const refresh = reconciliation?.domains[0]
    expect(refresh).toMatchObject({
      apexDomain: "thenootropics.guide",
      expiresAt: renewedAt,
      checkedAt: now,
    })
    const nextDue = selectDueDomainHealthTargets(
      {
        apexDomains: ["thenootropics.guide"],
        certificates: [],
        monitors: [],
      },
      {
        domains: new Map([
          [
            "thenootropics.guide",
            {
              apexDomain: "thenootropics.guide",
              expiresAt: refresh?.expiresAt ?? expiresAt,
              registrar: "Porkbun LLC",
              checkedAt: refresh?.checkedAt ?? checkedAt,
              lastSuccessAt: now,
              lastReferencedAt: now,
            },
          ],
        ]),
        certificates: new Map(),
      },
      new Date(now.getTime() + 10 * 60_000)
    )

    expect(nextDue.apexDomains).toEqual([])
  })

  it("dedupes sibling subdomains by apex and exact certificate endpoint", async () => {
    const { runs, leases } = stores()
    const probeCert = vi.fn(async () => certFacts)
    const fetchDomain = vi.fn(async () => domainFacts)
    const reconcile = vi.fn(
      async (_input: DomainHealthReconciliation) => undefined
    )

    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [
        { id: "one", url: "https://app.example.com/health" },
        { id: "two", url: "https://app.example.com/other" },
        { id: "three", url: "https://status.example.com" },
        { id: "disabled", url: "http://paused.example.com" },
      ],
      loadAssets: async () => emptyAssets(),
      probeCert,
      fetchDomain,
      reconcile,
    })

    expect(fetchDomain).toHaveBeenCalledTimes(1)
    expect(fetchDomain).toHaveBeenCalledWith("example.com")
    expect(probeCert).toHaveBeenCalledTimes(2)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it("reuses existing assets inside the freshness window", async () => {
    const { runs, leases } = stores()
    const now = new Date("2026-07-22T12:00:00Z")
    const checkedAt = new Date(now.getTime() - DOMAIN_HEALTH_FRESHNESS_MS + 1)
    const probeCert = vi.fn(async () => certFacts)
    const fetchDomain = vi.fn(async () => domainFacts)

    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      now: () => now,
      loadMonitors: async () => [{ id: "one", url: "https://app.example.com" }],
      loadAssets: async () => ({
        domains: new Map([
          [
            "example.com",
            {
              apexDomain: "example.com",
              expiresAt: null,
              registrar: null,
              checkedAt,
              lastSuccessAt: null,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
        certificates: new Map([
          [
            certificateAssetKey("app.example.com", 443),
            {
              hostname: "app.example.com",
              port: 443,
              expiresAt: null,
              issuer: null,
              checkedAt,
              lastSuccessAt: null,
              lastReferencedAt: checkedAt,
            },
          ],
        ]),
      }),
      probeCert,
      fetchDomain,
      reconcile: async () => undefined,
    })

    expect(probeCert).not.toHaveBeenCalled()
    expect(fetchDomain).not.toHaveBeenCalled()
  })

  it("treats referenced assets without an attempt as immediately due", async () => {
    const { runs, leases } = stores()
    const probeCert = vi.fn(async () => certFacts)
    const fetchDomain = vi.fn(async () => domainFacts)
    await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [
        { id: "one", url: "https://new.example.com:8443" },
      ],
      loadAssets: async (targets) => ({
        domains: new Map(
          targets.apexDomains.map((apexDomain) => [
            apexDomain,
            {
              apexDomain,
              expiresAt: null,
              registrar: null,
              checkedAt: null,
              lastSuccessAt: null,
              lastReferencedAt: new Date(),
            },
          ])
        ),
        certificates: new Map(
          targets.certificates.map((target) => [
            certificateAssetKey(target.hostname, target.port),
            {
              ...target,
              expiresAt: null,
              issuer: null,
              checkedAt: null,
              lastSuccessAt: null,
              lastReferencedAt: new Date(),
            },
          ])
        ),
      }),
      probeCert,
      fetchDomain,
      reconcile: async () => undefined,
    })
    expect(fetchDomain).toHaveBeenCalledOnce()
    expect(probeCert).toHaveBeenCalledWith("new.example.com", 8443)
  })

  it("admits both lookup classes before the deadline", async () => {
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
      loadAssets: async () => emptyAssets(),
      probeCert,
      fetchDomain,
      reconcile: async () => undefined,
    })

    expect(fetchDomain).toHaveBeenCalledTimes(1)
    expect(probeCert).toHaveBeenCalledTimes(1)
    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.skippedLookups).toBe(6)
      expect(result.counts).toEqual({
        monitorCount: 4,
        successCount: 1,
        failureCount: 0,
        skippedCount: 3,
        unknownCount: 0,
      })
    }
  })

  it("counts clean lookups without facts as unknown, not failure", async () => {
    const { runs, leases } = stores()
    const reconcile = vi.fn(
      async (_input: DomainHealthReconciliation) => undefined
    )

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [{ id: "one", url: "https://app.example.com" }],
      loadAssets: async () => emptyAssets(),
      probeCert: async () => ({
        expiresAt: new Date("2026-10-12T00:00:00Z"),
        issuer: "Let's Encrypt",
      }),
      fetchDomain: async () => ({
        expiresAt: null,
        registrar: null,
        outcome: "uncovered" as const,
      }),
      reconcile,
    })

    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      // The cert lookup produced facts, so the monitor is a success even
      // though RDAP has nothing for the apex.
      expect(result.counts).toEqual({
        monitorCount: 1,
        successCount: 1,
        failureCount: 0,
        skippedCount: 0,
        unknownCount: 0,
      })
    }
  })

  it("keeps a factless cert probe a failure even when the apex is uncovered", async () => {
    const { runs, leases } = stores()
    const reconcile = vi.fn(
      async (_input: DomainHealthReconciliation) => undefined
    )

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [{ id: "one", url: "https://app.example.com" }],
      loadAssets: async () => emptyAssets(),
      probeCert: async () => ({ expiresAt: null, issuer: null }),
      fetchDomain: async () => ({
        expiresAt: null,
        registrar: null,
        outcome: "uncovered" as const,
      }),
      reconcile,
    })

    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      // A cert probe that cannot produce facts is a real failure, the
      // handshake either broke or was refused, so the monitor is a failure.
      expect(result.counts).toEqual({
        monitorCount: 1,
        successCount: 0,
        failureCount: 1,
        skippedCount: 0,
        unknownCount: 0,
      })
    }
  })

  it("counts a domain-only monitor as unknown when RDAP has no coverage", async () => {
    const { runs, leases } = stores()
    const reconcile = vi.fn(
      async (_input: DomainHealthReconciliation) => undefined
    )

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [{ id: "one", url: "http://app.example.com" }],
      loadAssets: async () => emptyAssets(),
      probeCert: async () => {
        throw new Error("never called for http monitors")
      },
      fetchDomain: async () => ({
        expiresAt: null,
        registrar: null,
        outcome: "uncovered" as const,
      }),
      reconcile,
    })

    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.counts).toEqual({
        monitorCount: 1,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        unknownCount: 1,
      })
    }
  })

  it("records rejected lookups as failed attempts", async () => {
    const { runs, leases } = stores()
    const reconcile = vi.fn(
      async (_input: DomainHealthReconciliation) => undefined
    )

    const result = await runDomainHealthCoordinator({
      leases,
      runs,
      releaseId: "dpl_test",
      loadMonitors: async () => [{ id: "one", url: "https://app.example.com" }],
      loadAssets: async () => emptyAssets(),
      probeCert: async () => {
        throw new Error("TLS unavailable")
      },
      fetchDomain: async () => {
        throw new Error("RDAP unavailable")
      },
      reconcile,
    })

    expect(result.status).toBe("completed")
    if (result.status === "completed") {
      expect(result.counts).toEqual({
        monitorCount: 1,
        successCount: 0,
        failureCount: 1,
        skippedCount: 0,
        unknownCount: 0,
      })
      expect(result.certProbes).toBe(1)
      expect(result.rdapLookups).toBe(1)
    }
    const input = reconcile.mock.calls[0]?.[0]
    expect(input?.domains[0]).toMatchObject({
      apexDomain: "example.com",
      expiresAt: null,
      registrar: null,
    })
    expect(input?.certificates[0]).toMatchObject({
      hostname: "app.example.com",
      port: 443,
      expiresAt: null,
      issuer: null,
    })
  })
})
