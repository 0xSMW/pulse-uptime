import { describe, expect, it, vi } from "vitest"
import { evaluateConfigurationAcceptance } from "@/lib/config/acceptance"
import { hashCanonical } from "@/lib/config/canonical"
import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
} from "@/lib/config/defaults"
import type { MonitoringConfig } from "@/lib/config/schema"

import {
  evaluateConfigurationSource,
  requireApprovalConsumption,
} from "./configuration"

describe("configuration source fallback", () => {
  const config: MonitoringConfig = {
    schemaVersion: 2,
    configVersion: 1,
    settings: { ...DEFAULT_MONITOR_SETTINGS, defaultRecipients: [] },
    groups: [],
    monitors: [
      createMonitorWithDefaults({
        id: "site-one",
        name: "Site one",
        url: "https://example.com",
      }),
    ],
  }
  const previous = { config, hash: hashCanonical(config) }

  it.each(["read failure", "missing value"])(
    "uses the accepted snapshot after %s",
    async (scenario) => {
      const loaded = await evaluateConfigurationSource({
        readDesired:
          scenario === "read failure"
            ? async () => {
                throw new Error("edge unavailable")
              }
            : async () => undefined,
        previous,
        now: new Date("2026-07-18T04:00:00Z"),
      })
      expect(loaded.sourceError).toBe(true)
      expect(loaded.result.status).toBe("rejected")
      if (loaded.result.status === "rejected") {
        expect(loaded.result.config).toEqual(previous.config)
      }
    }
  )

  it("fails when neither Edge Config nor an accepted snapshot exists", async () => {
    const loaded = await evaluateConfigurationSource({
      readDesired: async () => {
        throw new Error("edge unavailable")
      },
      previous: null,
      now: new Date(),
    })
    expect(loaded.result.status).toBe("unavailable")
  })

  it("falls back if conditional approval consumption loses its race", async () => {
    const desired = { ...config, configVersion: 2, monitors: [] }
    const unapproved = evaluateConfigurationAcceptance(desired, previous, {
      now: new Date("2026-07-18T04:00:00Z"),
    })
    if (unapproved.status !== "rejected" || !unapproved.candidateHash) {
      throw new Error("Expected destructive candidate")
    }
    const approved = evaluateConfigurationAcceptance(desired, previous, {
      now: new Date("2026-07-18T04:00:00Z"),
      approval: {
        targetConfigHash: unapproved.candidateHash,
        action: "destructive_config_change",
        expiresAt: new Date("2026-07-18T04:10:00Z"),
        consumedAt: null,
      },
    })
    const consume = vi.fn().mockResolvedValue(false)
    expect(approved.status).toBe("accepted")
    if (approved.status === "accepted") {
      expect(approved.approvalConsumed).toBe(true)
    }
    const result = await requireApprovalConsumption({
      result: approved,
      desired,
      previous,
      now: new Date("2026-07-18T04:00:00Z"),
      consume,
    })
    expect(consume).toHaveBeenCalledOnce()
    expect(result.status).toBe("rejected")
  })
})
