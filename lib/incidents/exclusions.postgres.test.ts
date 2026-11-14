import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { executeIdempotent } from "@/lib/api/idempotency"
import { sql as sharedClient } from "@/lib/db/client"
import * as schema from "@/lib/db/schema"
import { encodeTelemetry } from "@/lib/storage/codec"
import {
  applyIncidentExclusion,
  listIncidentExclusions,
  loadExclusionSlots,
  loadIncidentExclusionStatuses,
  previewIncidentExclusion,
  undoIncidentExclusion,
} from "./exclusions"

const url = process.env.TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite("incident exclusion PostgreSQL invariants", () => {
  const client = postgres(url!, { max: 5, prepare: false })
  const database = drizzle(client, { schema })
  let sequence = 0
  afterAll(async () => {
    await client.end()
    await sharedClient.end()
  })
  async function fixture() {
    sequence += 1
    let minute =
      Math.floor(Date.now() / 900_000) * 900_000 - (60 + sequence * 10) * 60_000
    while (
      (
        await database
          .select({ minute: schema.checkBatches.scheduledMinute })
          .from(schema.checkBatches)
          .where(eq(schema.checkBatches.scheduledMinute, new Date(minute)))
      ).length
    ) {
      minute -= 5 * 60_000
    }
    const start = new Date(minute)
    const monitorId = `exclusion-${crypto.randomUUID()}`
    const incidentId = crypto.randomUUID()
    const openedAt = new Date(minute + 3600)
    const resolvedAt = new Date(minute + 3 * 60_000 + 3600)
    await database.insert(schema.monitorRegistry).values({
      id: monitorId,
      name: monitorId,
      url: "https://example.com",
      enabled: true,
      configHash: "fixture",
      firstSeenAt: new Date(minute - 86_400_000),
      lastSeenAt: resolvedAt,
    })
    await database.insert(schema.monitorState).values({
      monitorId,
      state: "UP",
      activatedAt: new Date(minute - 86_400_000),
      updatedAt: resolvedAt,
    })
    await database.insert(schema.incidents).values({
      id: incidentId,
      monitorId,
      openedAt,
      firstFailureAt: openedAt,
      resolvedAt,
      firstSuccessAt: resolvedAt,
      createdAt: openedAt,
      updatedAt: resolvedAt,
    })
    for (let index = 0; index < 4; index += 1) {
      const scheduledMinute = new Date(minute + index * 60_000)
      // Expected unknown remains coverage, successes remain successes.
      const packed = encodeTelemetry([
        {
          expected: true,
          completed: index !== 1,
          failed: index === 0 || index === 2,
          latencyMs: index === 1 ? null : 120,
        },
      ])
      await database.insert(schema.checkBatches).values({
        ...packed,
        scheduledMinute,
        configVersion: 1,
        monitorIds: [monitorId],
        schedulerStartedAt: scheduledMinute,
        schedulerCompletedAt: new Date(scheduledMinute.getTime() + 1000),
        createdAt: scheduledMinute,
      })
    }
    return { start, monitorId, incidentId, resolvedAt }
  }
  it("captures exact failures and recovery downtime while retaining observed counts", async () => {
    const f = await fixture()
    const preview = await previewIncidentExclusion(f.incidentId, {}, database)
    expect(preview.startAt).toBe(f.start.toISOString())
    expect(preview.endAt).toBe(
      new Date(f.start.getTime() + 4 * 60_000).toISOString()
    )
    expect(preview.affectedFailedChecks).toBe(2)
    expect(preview.before).toMatchObject({
      expectedChecks: 4,
      completedChecks: 3,
      successfulChecks: 1,
      failedChecks: 2,
      unknownChecks: 1,
      excludedFailedChecks: 0,
    })
    expect(preview.before.uptime).toBeCloseTo(100 / 3)
    expect(preview.after).toMatchObject({
      expectedChecks: 4,
      completedChecks: 3,
      successfulChecks: 1,
      failedChecks: 2,
      unknownChecks: 1,
      excludedFailedChecks: 2,
      uptime: 100,
    })
    const before = await database
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, f.incidentId))
    const row = await database.transaction((tx) =>
      applyIncidentExclusion(
        f.incidentId,
        { ...preview, reason: " False alarm " },
        "human:fixture",
        crypto.randomUUID(),
        tx
      )
    )
    expect(row.reason).toBe("False alarm")
    const slots = await loadExclusionSlots(
      [f.monitorId],
      f.start,
      new Date(f.start.getTime() + 4 * 60_000),
      database
    )
    expect(slots).toHaveLength(4)
    expect(slots.filter((slot) => slot.failed)).toHaveLength(2)
    expect(slots.map((slot) => slot.downtimeSeconds)).toEqual([60, 60, 60, 60])
    expect(slots.at(-1)?.failed).toBe(false)
    expect(
      (await loadIncidentExclusionStatuses([f.incidentId], database)).get(
        f.incidentId
      )
    ).toBe("full")
    expect(
      await database
        .select()
        .from(schema.incidents)
        .where(eq(schema.incidents.id, f.incidentId))
    ).toEqual(before)
    const reverted = await database.transaction((tx) =>
      undoIncidentExclusion(f.incidentId, row.id, "api_token:undoer", tx)
    )
    expect(reverted.createdByPrincipal).toBe("human:fixture")
    expect(reverted.revertedByPrincipal).toBe("api_token:undoer")
    expect(
      await loadExclusionSlots(
        [f.monitorId],
        f.start,
        new Date(f.start.getTime() + 4 * 60_000),
        database
      )
    ).toEqual([])
    expect((await listIncidentExclusions(f.incidentId, database))[0]).toEqual(
      reverted
    )
    expect(
      await database.transaction((tx) =>
        undoIncidentExclusion(f.incidentId, row.id, "human:other", tx)
      )
    ).toEqual(reverted)
    expect(
      await database
        .select()
        .from(schema.incidentExclusionChecks)
        .where(eq(schema.incidentExclusionChecks.exclusionId, row.id))
    ).toHaveLength(4)
  })
  it("rejects stale previews without writing audit or slots", async () => {
    const f = await fixture()
    const preview = await previewIncidentExclusion(f.incidentId, {}, database)
    const result = database.transaction((tx) =>
      applyIncidentExclusion(
        f.incidentId,
        { ...preview, previewVersion: "0".repeat(64), reason: "false alarm" },
        "human:fixture",
        crypto.randomUUID(),
        tx
      )
    )
    await expect(result).rejects.toMatchObject({
      code: "EXCLUSION_PREVIEW_CHANGED",
    })
    expect(await listIncidentExclusions(f.incidentId, database)).toEqual([])
  })
  it("fails closed when a selected minute lacks retained evidence", async () => {
    const f = await fixture()
    await database
      .delete(schema.checkBatches)
      .where(
        eq(
          schema.checkBatches.scheduledMinute,
          new Date(f.start.getTime() + 60_000)
        )
      )
    await expect(
      previewIncidentExclusion(f.incidentId, {}, database)
    ).rejects.toMatchObject({ code: "EXCLUSION_EVIDENCE_UNAVAILABLE" })
  })
  it("serializes concurrent applies and prevents overlapping active exclusions", async () => {
    const f = await fixture()
    const preview = await previewIncidentExclusion(f.incidentId, {}, database)
    const apply = () =>
      database.transaction((tx) =>
        applyIncidentExclusion(
          f.incidentId,
          { ...preview, reason: "false alarm" },
          "human:fixture",
          crypto.randomUUID(),
          tx
        )
      )
    const results = await Promise.allSettled([apply(), apply()])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      results.find((result) => result.status === "rejected")
    ).toMatchObject({ reason: { code: "EXCLUSION_OVERLAP" } })
    expect(await listIncidentExclusions(f.incidentId, database)).toHaveLength(1)
  })
  it.skipIf(process.env.DATABASE_URL !== url)(
    "replays committed operations and rolls back mutation with failed completion work",
    async () => {
      const f = await fixture()
      const preview = await previewIncidentExclusion(f.incidentId, {}, database)
      const input = { ...preview, reason: "false alarm" }
      const key = crypto.randomUUID()
      const request = new Request(
        `https://example.com/api/v1/incidents/${f.incidentId}/exclusions`,
        { method: "POST", headers: { "Idempotency-Key": key } }
      )
      let calls = 0
      const run = () =>
        executeIdempotent({
          request,
          principalKey: "human:fixture",
          routeKey: "test-exclusion",
          body: input,
          mode: "atomic",
          work: async (tx, context) => {
            calls += 1
            return {
              status: 201,
              body: await applyIncidentExclusion(
                f.incidentId,
                input,
                "human:fixture",
                context.operationId,
                tx
              ),
            }
          },
        })
      const first = await run()
      const replay = await run()
      expect(first.replayed).toBe(false)
      expect(replay.replayed).toBe(true)
      expect(replay.body).toEqual(first.body)
      expect(calls).toBe(1)
      const other = await fixture()
      const otherPreview = await previewIncidentExclusion(
        other.incidentId,
        {},
        database
      )
      await expect(
        executeIdempotent({
          request: new Request("https://example.com/rollback", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
          }),
          principalKey: "human:fixture",
          routeKey: "rollback",
          body: {},
          mode: "atomic",
          work: async (tx, context) => {
            await applyIncidentExclusion(
              other.incidentId,
              { ...otherPreview, reason: "rollback" },
              "human:fixture",
              context.operationId,
              tx
            )
            throw new Error("Injected failure before completion")
          },
        })
      ).rejects.toThrow("Injected failure")
      expect(await listIncidentExclusions(other.incidentId, database)).toEqual(
        []
      )
    }
  )
  it("clips effective downtime after an ongoing recovery resolves retroactively", async () => {
    const f = await fixture()
    await database
      .update(schema.incidents)
      .set({ resolvedAt: null, firstSuccessAt: f.resolvedAt })
      .where(eq(schema.incidents.id, f.incidentId))
    const laterMinute = new Date(f.start.getTime() + 4 * 60_000)
    const packed = encodeTelemetry([
      { expected: true, completed: true, failed: false, latencyMs: 100 },
    ])
    await database.insert(schema.checkBatches).values({
      ...packed,
      scheduledMinute: laterMinute,
      configVersion: 1,
      monitorIds: [f.monitorId],
      schedulerStartedAt: laterMinute,
      schedulerCompletedAt: new Date(laterMinute.getTime() + 1000),
      createdAt: laterMinute,
    })
    const preview = await previewIncidentExclusion(f.incidentId, {}, database)
    expect(preview.endAt).toBe(
      new Date(laterMinute.getTime() + 60_000).toISOString()
    )
    const row = await database.transaction((tx) =>
      applyIncidentExclusion(
        f.incidentId,
        { ...preview, reason: "ongoing false alarm" },
        "human:fixture",
        crypto.randomUUID(),
        tx
      )
    )
    await database
      .update(schema.incidents)
      .set({ resolvedAt: f.resolvedAt })
      .where(eq(schema.incidents.id, f.incidentId))
    const persisted = await database
      .select()
      .from(schema.incidentExclusionChecks)
      .where(eq(schema.incidentExclusionChecks.exclusionId, row.id))
    expect(
      persisted.find(
        (slot) => slot.scheduledMinute.getTime() === laterMinute.getTime()
      )?.downtimeSeconds
    ).toBe(60)
    const effective = await loadExclusionSlots(
      [f.monitorId],
      f.start,
      new Date(laterMinute.getTime() + 60_000),
      database
    )
    expect(
      effective.find(
        (slot) => slot.scheduledMinute.getTime() === laterMinute.getTime()
      )?.downtimeSeconds
    ).toBe(0)
    expect(
      effective.find(
        (slot) =>
          slot.scheduledMinute.getTime() === laterMinute.getTime() - 60_000
      )?.downtimeSeconds
    ).toBe(60)
  })
  it("rejects a preview whose promised reporting window changed at a quarter hour", async () => {
    const f = await fixture()
    const preview = await previewIncidentExclusion(f.incidentId, {}, database)
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900_000)
    try {
      await expect(
        database.transaction((tx) =>
          applyIncidentExclusion(
            f.incidentId,
            { ...preview, reason: "false alarm" },
            "human:fixture",
            crypto.randomUUID(),
            tx
          )
        )
      ).rejects.toMatchObject({ code: "EXCLUSION_PREVIEW_CHANGED" })
    } finally {
      clock.mockRestore()
    }
    expect(await listIncidentExclusions(f.incidentId, database)).toEqual([])
  })
})
