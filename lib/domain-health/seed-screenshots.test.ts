import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const gate = process.env.SEED_SCREENSHOTS === "1"
const suite = gate ? describe : describe.skip

const DAY = 86_400_000

suite("seed staging for expiry display screenshots", () => {
  it("seeds monitors, warning assets, and a demo admin", async () => {
    const {
      createMonitorWithDefaults,
      DEFAULT_MONITOR_SETTINGS,
      hashMonitoringConfig,
    } = await import("@/lib/config")
    const { hashPassword } = await import("@/lib/auth/credentials")
    const { db } = await import("@/lib/db/client")
    const schema = await import("@/lib/db/schema")

    const now = new Date()
    const monitors = [
      { id: "thenootropics-guide", name: "thenootropics.guide", url: "https://thenootropics.guide/" },
      { id: "agilefirst-io", name: "agilefirst.io", url: "https://agilefirst.io/" },
      { id: "productstrategy-co", name: "productstrategy.co", url: "https://productstrategy.co/" },
      { id: "stephenwalker-co", name: "stephenwalker.co", url: "https://stephenwalker.co/" },
    ]
    const config = {
      schemaVersion: 2,
      configVersion: 1,
      settings: { ...DEFAULT_MONITOR_SETTINGS },
      groups: [],
      monitors: monitors.map((m) => createMonitorWithDefaults(m)),
    }

    await db.delete(schema.monitorDomainHealth)
    await db.delete(schema.certificateHealthAssets)
    await db.delete(schema.domainHealthAssets)
    await db.delete(schema.monitorExceptions)
    await db.delete(schema.monitorState)
    await db.delete(schema.monitorRegistry)
    await db.delete(schema.monitoringConfigSnapshots)

    const hash = hashMonitoringConfig(config)
    await db.insert(schema.monitoringConfigSnapshots).values({
      id: crypto.randomUUID(),
      configVersion: 1,
      configHash: hash,
      configJson: config,
      status: "accepted",
      source: "api",
      seenAt: now,
      acceptedAt: now,
    })
    await db.insert(schema.monitorRegistry).values(
      monitors.map((m) => ({
        ...m,
        enabled: true,
        configHash: hash,
        firstSeenAt: new Date(now.getTime() - 30 * DAY),
        lastSeenAt: now,
      }))
    )
    await db.insert(schema.monitorState).values(
      monitors.map((m) => ({ monitorId: m.id, state: "UP", updatedAt: now }))
    )

    const at = (days: number) => new Date(now.getTime() + days * DAY)
    await db.insert(schema.domainHealthAssets).values([
      { apexDomain: "thenootropics.guide", expiresAt: at(1.5), registrar: "Porkbun LLC", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { apexDomain: "agilefirst.io", expiresAt: at(3.5), registrar: "Porkbun LLC", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { apexDomain: "productstrategy.co", expiresAt: at(320), registrar: "Porkbun LLC", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { apexDomain: "stephenwalker.co", expiresAt: at(300), registrar: "Porkbun LLC", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
    ])
    await db.insert(schema.certificateHealthAssets).values([
      { hostname: "thenootropics.guide", port: 443, expiresAt: at(46.5), issuer: "Google Trust Services", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { hostname: "agilefirst.io", port: 443, expiresAt: at(20.5), issuer: "Google Trust Services", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { hostname: "productstrategy.co", port: 443, expiresAt: at(20.5), issuer: "Google Trust Services", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
      { hostname: "stephenwalker.co", port: 443, expiresAt: at(80.5), issuer: "Google Trust Services", checkedAt: now, lastSuccessAt: now, lastReferencedAt: now },
    ])

    await db.delete(schema.humanSessions)
    await db.delete(schema.adminUsers)
    await db.insert(schema.adminUsers).values({
      id: crypto.randomUUID(),
      email: "demo@pulse.local",
      name: "Demo Admin",
      passwordDigest: await hashPassword("screenshot-demo-password-1"),
      role: "admin",
      createdAt: now,
      updatedAt: now,
      passwordChangedAt: now,
      onboardingCompletedAt: now,
    })

    expect(true).toBe(true)
  }, 60_000)
})
