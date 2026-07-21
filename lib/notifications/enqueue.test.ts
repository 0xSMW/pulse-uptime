import { describe, expect, it } from "vitest"

import type { DatabaseHandle } from "@/lib/db/client"

import { enqueueDependencyNotifications } from "./enqueue"

const baseDependencyInput = {
  event: "incident" as const,
  sourceId: "vercel",
  incidentExternalId: "inc-1",
  presetId: "vercel_runtime",
  scopeId: null as string | null,
  dependencyId: "dep-1",
  dependencyName: "Vercel Runtime",
  provider: "Vercel",
  incidentTitle: "Elevated function errors",
  state: "OUTAGE",
  canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
  providerTimestamp: "2026-07-19T12:00:00.000Z",
  latestUpdate: null as { body: string; timestamp: string } | null,
}

// Fakes the Drizzle chain enqueueDependencyNotifications now runs on
// (db.insert(...).values(...).onConflictDoNothing(...).returning(...))
// instead of the raw SqlExecutor the incident-notification path above still
// uses. This is the same handle shape a transaction exposes, which is the
// point: persist.ts passes its tx here so the outbox insert joins whatever
// transaction the caller is already in.
function fakeDependencyDb(resultRows: { id: string }[] = [{ id: "inserted" }]) {
  const calls: { rows?: readonly Record<string, unknown>[]; target?: unknown } =
    {}
  const db = {
    insert: () => ({
      values: (rows: readonly Record<string, unknown>[]) => {
        calls.rows = rows
        return {
          onConflictDoNothing: (options: { target: unknown }) => {
            calls.target = options.target
            return { returning: async () => resultRows }
          },
        }
      },
    }),
  } as unknown as DatabaseHandle
  return { db, calls }
}

describe("dependency notification enqueue", () => {
  it("returns 0 and issues no insert when there are no recipients", async () => {
    const { db, calls } = fakeDependencyDb()
    const inserted = await enqueueDependencyNotifications(db, {
      ...baseDependencyInput,
      recipients: [],
    })
    expect(inserted).toBe(0)
    expect(calls.rows).toBeUndefined()
  })

  it("enqueues a dependency incident with monitor_id and incident_id left unset", async () => {
    const { db, calls } = fakeDependencyDb()
    const inserted = await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        recipients: ["ops@example.com"],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-1",
      }
    )

    expect(inserted).toBe(1)
    expect(calls.rows).toHaveLength(1)
    const row = calls.rows![0]!
    expect(row.monitorId).toBeUndefined()
    expect(row.incidentId).toBeUndefined()
    expect(row).toMatchObject({
      id: "notification-1",
      dependencyId: "dep-1",
      eventType: "dependency.incident",
      recipient: "ops@example.com",
      idempotencyKey: expect.stringMatching(
        /^dependency\/vercel\/inc-1\/vercel_runtime\/\/incident\/[a-f0-9]{64}$/
      ),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date("2026-07-19T12:00:00Z"),
      createdAt: new Date("2026-07-19T12:00:00Z"),
      updatedAt: new Date("2026-07-19T12:00:00Z"),
    })
    // A null latestUpdate is omitted from the payload, not stored as null.
    expect(row.payload).toStrictEqual({
      type: "dependency.incident",
      dependencyName: "Vercel Runtime",
      provider: "Vercel",
      incidentTitle: "Elevated function errors",
      state: "OUTAGE",
      canonicalUrl: "https://www.vercel-status.com/incidents/inc-1",
      providerTimestamp: "2026-07-19T12:00:00.000Z",
    })
  })

  it("carries the latest provider update quote into the payload when present", async () => {
    const { db, calls } = fakeDependencyDb()
    await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        latestUpdate: {
          body: "We are currently investigating elevated function errors.",
          timestamp: "2026-07-19T12:05:00.000Z",
        },
        recipients: ["ops@example.com"],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-1",
      }
    )
    expect(calls.rows![0]!.payload).toMatchObject({
      latestUpdate: {
        body: "We are currently investigating elevated function errors.",
        timestamp: "2026-07-19T12:05:00.000Z",
      },
    })
  })

  it("builds a dependency.recovery payload for the recovery event", async () => {
    const { db, calls } = fakeDependencyDb()
    await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        event: "recovery",
        recipients: ["ops@example.com"],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-1",
      }
    )
    const row = calls.rows![0]!
    expect(row.idempotencyKey).toMatch(
      /^dependency\/vercel\/inc-1\/vercel_runtime\/\/recovery\//
    )
    expect((row.payload as { type: string }).type).toBe("dependency.recovery")
  })

  it("deduplicates normalized duplicate recipients", async () => {
    const { db, calls } = fakeDependencyDb()
    const inserted = await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        recipients: ["Ops@example.com", " ops@EXAMPLE.com "],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-1",
      }
    )
    expect(inserted).toBe(1)
    expect(calls.rows).toHaveLength(1)
  })

  it("relies on the idempotency key constraint to report only newly inserted rows", async () => {
    const recipients = ["a@example.com", "b@example.com", "c@example.com"]
    const { db, calls } = fakeDependencyDb([{ id: "kept-1" }])
    const inserted = await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        recipients,
      },
      { now: new Date("2026-07-19T12:00:00Z"), createId: () => "generated-id" }
    )
    expect(inserted).toBe(1)
    expect(calls.rows).toHaveLength(3)
  })

  it("targets the idempotency key column on conflict, one row per recipient", async () => {
    const { db, calls } = fakeDependencyDb()
    await enqueueDependencyNotifications(
      db,
      {
        ...baseDependencyInput,
        recipients: ["a@example.com", "b@example.com"],
      },
      { now: new Date("2026-07-19T12:00:00Z"), createId: () => "generated-id" }
    )
    expect(calls.rows).toHaveLength(2)
    expect(calls.target).toBeDefined()
  })

  it("gives two scoped installs of the same preset distinct idempotency keys (FIX C)", async () => {
    const us = fakeDependencyDb()
    await enqueueDependencyNotifications(
      us.db,
      {
        ...baseDependencyInput,
        scopeId: "us-east-1",
        recipients: ["ops@example.com"],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-1",
      }
    )
    const usKey = us.calls.rows![0]!.idempotencyKey as string

    const eu = fakeDependencyDb()
    await enqueueDependencyNotifications(
      eu.db,
      {
        ...baseDependencyInput,
        scopeId: "eu-west-2",
        recipients: ["ops@example.com"],
      },
      {
        now: new Date("2026-07-19T12:00:00Z"),
        createId: () => "notification-2",
      }
    )
    const euKey = eu.calls.rows![0]!.idempotencyKey as string

    expect(usKey).not.toBe(euKey)
    expect(usKey).toContain("/us-east-1/")
    expect(euKey).toContain("/eu-west-2/")
  })
})
