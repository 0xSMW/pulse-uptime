import { readdir, readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"

import { desc, eq, isNull } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/config/edge-config-write", () => ({
  writeMonitoringEdgeConfig: vi.fn(async () => 1),
}))

import {
  createMonitorWithDefaults,
  DEFAULT_MONITOR_SETTINGS,
  hashMonitoringConfig,
  type MonitoringConfig,
} from "@/lib/config"
import * as schema from "@/lib/db/schema"

import { lockConfiguration } from "./configuration-lock"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

suite("configuration lock PostgreSQL concurrency", () => {
  // Two single-connection clients so concurrent transactions can block each other
  // on the transaction-scoped advisory lock rather than sharing one session.
  const clientA = postgres(databaseUrl!, { max: 1, prepare: false })
  const clientB = postgres(databaseUrl!, { max: 1, prepare: false })
  const dbA = drizzle(clientA, { schema })
  const dbB = drizzle(clientB, { schema })

  let mutateConfig: typeof import("./config-mutation").mutateConfig
  let closeModuleConnection: (() => Promise<void>) | undefined

  const baseConfig = (): MonitoringConfig => ({
    schemaVersion: 2,
    configVersion: 1,
    settings: { ...DEFAULT_MONITOR_SETTINGS },
    groups: [],
    monitors: [
      createMonitorWithDefaults({
        id: "cfg-lock-mon",
        name: "Lock Monitor",
        url: "https://example.com/health",
      }),
    ],
  })

  async function seedAccepted(config: MonitoringConfig): Promise<string> {
    const hash = hashMonitoringConfig(config)
    const now = new Date()
    // Wipe dependents first so re-seeds never trip FK order.
    await clientA`delete from monitor_state`
    await clientA`delete from monitor_registry`
    await clientA`delete from monitoring_config_snapshots`
    await dbA.insert(schema.monitoringConfigSnapshots).values({
      id: crypto.randomUUID(),
      configVersion: config.configVersion,
      configHash: hash,
      configJson: config,
      status: "accepted",
      source: "api",
      seenAt: now,
      acceptedAt: now,
    })
    await dbA.insert(schema.monitorRegistry).values({
      id: "cfg-lock-mon",
      name: "Lock Monitor",
      url: "https://example.com/health",
      enabled: true,
      configHash: hash,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    return hash
  }

  async function readAcceptedHash(
    executor: typeof dbA
  ): Promise<string | undefined> {
    const [row] = await executor
      .select({ configHash: schema.monitoringConfigSnapshots.configHash })
      .from(schema.monitoringConfigSnapshots)
      .where(eq(schema.monitoringConfigSnapshots.status, "accepted"))
      .orderBy(
        desc(schema.monitoringConfigSnapshots.acceptedAt),
        desc(schema.monitoringConfigSnapshots.seenAt)
      )
      .limit(1)
    return row?.configHash
  }

  async function readActiveRegistryHashes(
    executor: typeof dbA
  ): Promise<string[]> {
    const rows = await executor
      .select({ configHash: schema.monitorRegistry.configHash })
      .from(schema.monitorRegistry)
      .where(isNull(schema.monitorRegistry.archivedAt))
    return rows.map((row) => row.configHash)
  }

  beforeAll(async () => {
    // Fresh schema so re-runs on a shared TEST_DATABASE_URL do not trip
    // "relation already exists" from earlier migration applications.
    await clientA.unsafe("drop schema if exists public cascade")
    await clientA.unsafe("create schema public")
    const dir = resolvePath(process.cwd(), "drizzle")
    const files = (await readdir(dir))
      .filter((name) => name.endsWith(".sql"))
      .sort()
    for (const migration of files) {
      const source = await readFile(resolvePath(dir, migration), "utf8")
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((item) => item.trim())
        .filter(Boolean)) {
        await clientA.unsafe(statement)
      }
    }

    // mutateConfig binds its default handle to DATABASE_URL at import time.
    process.env.DATABASE_URL = databaseUrl
    ;({ mutateConfig } = await import("./config-mutation"))
    const { sql } = await import("@/lib/db/client")
    closeModuleConnection = () => sql.end({ timeout: 5 })
  }, 60_000)

  beforeEach(async () => {
    await seedAccepted(baseConfig())
  })

  afterAll(async () => {
    await closeModuleConnection?.()
    await clientA.end()
    await clientB.end()
  })

  it("serializes concurrent lock holders so the second transaction waits", async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstMayProceed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = dbA.transaction(async (tx) => {
      await lockConfiguration(tx)
      order.push("first-acquired")
      await firstMayProceed
      order.push("first-done")
    })

    // Give the first transaction time to acquire the lock before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = dbB.transaction(async (tx) => {
      await lockConfiguration(tx)
      order.push("second-acquired")
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(["first-acquired"])

    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(["first-acquired", "first-done", "second-acquired"])
  })

  it("keeps accepted snapshot hash and active registry hash agreed under concurrent mutateConfig", async () => {
    const bumpConcurrency =
      (delta: number) =>
      (config: MonitoringConfig): MonitoringConfig => ({
        ...config,
        schemaVersion: 2,
        configVersion: config.configVersion + 1,
        settings: {
          ...config.settings,
          concurrency: config.settings.concurrency + delta,
        },
      })

    // Two independent handles so each mutateConfig transaction uses its own
    // connection and can contend on the configuration advisory lock.
    const results = await Promise.all([
      mutateConfig("human:a", bumpConcurrency(1), dbA),
      mutateConfig("human:b", bumpConcurrency(2), dbB),
    ])

    expect(results.map((config) => config.configVersion).sort()).toEqual([2, 3])

    const acceptedHash = await readAcceptedHash(dbA)
    const registryHashes = await readActiveRegistryHashes(dbA)

    expect(acceptedHash).toBeTruthy()
    expect(registryHashes.length).toBeGreaterThan(0)
    for (const hash of registryHashes) {
      expect(hash).toBe(acceptedHash)
    }

    // Both mutations applied in series under the lock: version advanced twice.
    const [latest] = await dbA
      .select({
        configJson: schema.monitoringConfigSnapshots.configJson,
        configVersion: schema.monitoringConfigSnapshots.configVersion,
      })
      .from(schema.monitoringConfigSnapshots)
      .where(eq(schema.monitoringConfigSnapshots.status, "accepted"))
      .orderBy(
        desc(schema.monitoringConfigSnapshots.acceptedAt),
        desc(schema.monitoringConfigSnapshots.seenAt)
      )
      .limit(1)

    expect(latest).toBeDefined()
    expect(latest!.configVersion).toBe(3)
    const settings = (latest!.configJson as MonitoringConfig).settings
    // 25 + 1 + 2 regardless of which writer ran first.
    expect(settings.concurrency).toBe(28)
  })
})
