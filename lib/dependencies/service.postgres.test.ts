import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import * as schema from "@/lib/db/schema"

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

// Real-driver coverage for the install-time backfill savepoint. The unit test
// in service.test.ts simulates the failure with a rejected promise that never
// touches Postgres, so it cannot prove aborted-subtransaction semantics: a
// mid-statement error, ROLLBACK TO SAVEPOINT, then the outer transaction still
// writing and committing. This raises a genuine database error inside the scan
// and asserts the insert survives it. Mirrors idempotency.postgres.test.ts.
suite("dependency backfill failure isolation on PostgreSQL", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false })
  const verify = drizzle(client, { schema })

  let store: typeof import("./service").databaseDependenciesStore
  let closeModuleConnection: () => Promise<void>

  const NOW = new Date("2026-07-21T12:00:00.000Z")
  const SOURCE_ID = "src-backfill"
  const CATALOG_ID = "cat-backfill"
  const INCIDENT_ID = "inc-backfill"
  const DEP_ID = "dep-backfill"

  const matchRows = () =>
    verify
      .select()
      .from(schema.dependencyIncidentMatches)
      .where(eq(schema.dependencyIncidentMatches.dependencyId, DEP_ID))
  const dependencyRow = async () =>
    (
      await verify
        .select()
        .from(schema.dependencies)
        .where(eq(schema.dependencies.id, DEP_ID))
    )[0]

  beforeAll(async () => {
    // Full schema build: apply every migration in order, the way drizzle
    // migrate would, so the dependency tables and the new backfill_failed_at
    // column all exist.
    const files = (await readdir(resolve(process.cwd(), "drizzle")))
      .filter((name) => name.endsWith(".sql"))
      .sort()
    for (const migration of files) {
      const source = await readFile(
        resolve(process.cwd(), "drizzle", migration),
        "utf8"
      )
      for (const statement of source
        .split("--> statement-breakpoint")
        .map((item) => item.trim())
        .filter(Boolean)) {
        await client.unsafe(statement)
      }
    }

    // Seed a source, a component-scoped catalog preset, and a resolved incident
    // in the trailing 7 days whose component intersects the preset selector, so
    // the install-time backfill has exactly one match to attempt.
    await verify.insert(schema.dependencySources).values({
      id: SOURCE_ID,
      providerName: "Test Provider",
      adapter: "statuspage_v2",
      currentUrl: "https://status.example.com/api.json",
      statusPageUrl: "https://status.example.com",
      allowedHosts: ["status.example.com"],
      config: {},
      catalogVersion: "test",
      enabled: true,
    })
    await verify.insert(schema.dependencyCatalog).values({
      id: CATALOG_ID,
      sourceId: SOURCE_ID,
      displayName: "Test Dependency",
      category: "hosting",
      description: "Test",
      selector: { kind: "component_ids", ids: ["comp-1"] },
      fidelity: "component",
      catalogVersion: "test",
      enabled: true,
    })
    await verify.insert(schema.providerIncidents).values({
      id: INCIDENT_ID,
      sourceId: SOURCE_ID,
      externalId: "ext-1",
      title: "Resolved outage",
      state: "resolved",
      impact: "major",
      startedAt: new Date(NOW.getTime() - 2 * 3_600_000),
      resolvedAt: new Date(NOW.getTime() - 3_600_000),
      providerUpdatedAt: new Date(NOW.getTime() - 3_600_000),
      canonicalUrl: "https://status.example.com/incidents/ext-1",
    })
    await verify.insert(schema.providerIncidentComponents).values({
      incidentId: INCIDENT_ID,
      externalComponentId: "comp-1",
      associationKind: "explicit",
    })

    // The module under test binds its db client to DATABASE_URL at import time,
    // so the env var must point at the test database before the dynamic import
    // below evaluates lib/db/client.ts.
    process.env.DATABASE_URL = databaseUrl
    ;({ databaseDependenciesStore: store } = await import("./service"))
    const { sql } = await import("@/lib/db/client")
    closeModuleConnection = () => sql.end()
  }, 60_000)

  afterAll(async () => {
    await closeModuleConnection()
    await client.end()
  })

  it("commits the install and marks backfill_failed_at when the scan raises inside the savepoint, leaving zero matches", async () => {
    // A BEFORE INSERT trigger raises a genuine error the moment the backfill's
    // match insert runs, forcing a real ROLLBACK TO SAVEPOINT rather than the
    // mocked rejection the unit test simulates.
    await client.unsafe(
      "create or replace function pulse_test_block_match() returns trigger as $$ begin raise exception 'backfill scan fault'; end; $$ language plpgsql"
    )
    await client.unsafe(
      "create trigger pulse_test_block_match before insert on dependency_incident_matches for each row execute function pulse_test_block_match()"
    )

    let inserted: boolean
    try {
      inserted = await store.insertDependency({
        dependency: {
          id: DEP_ID,
          catalogId: CATALOG_ID,
          scopeId: null,
          notificationsEnabled: true,
          createdAt: NOW,
          removedAt: null,
        },
        state: {
          state: "UNKNOWN",
          pendingFirstPoll: true,
          observedAt: NOW,
          providerUpdatedAt: null,
        },
        intervalId: "interval-backfill",
        sourceId: SOURCE_ID,
        now: NOW,
      })
    } finally {
      await client.unsafe(
        "drop trigger pulse_test_block_match on dependency_incident_matches"
      )
    }

    // The install committed despite the aborted subtransaction.
    expect(inserted).toBe(true)
    const dep = await dependencyRow()
    expect(dep).toBeTruthy()
    // The failure is marked durably for a manual retry.
    expect(dep?.backfillFailedAt).toBeInstanceOf(Date)
    // The savepoint discarded every partial match write.
    expect(await matchRows()).toHaveLength(0)
    // The state and interval rows committed too, proving the outer transaction
    // kept writing after the subtransaction rolled back.
    const state = await verify
      .select()
      .from(schema.dependencyState)
      .where(eq(schema.dependencyState.dependencyId, DEP_ID))
    expect(state).toHaveLength(1)
    const intervals = await verify
      .select()
      .from(schema.dependencyStateIntervals)
      .where(eq(schema.dependencyStateIntervals.dependencyId, DEP_ID))
    expect(intervals).toHaveLength(1)
  })

  it("retryBackfill re-runs the scan for real, inserts the match, and clears the mark", async () => {
    const retried = await store.retryBackfill(DEP_ID)
    expect(retried).toBe(true)
    const matches = await matchRows()
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      incidentId: INCIDENT_ID,
      matchKind: "component_match",
    })
    expect((await dependencyRow())?.backfillFailedAt).toBeNull()
  })
})
