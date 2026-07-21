import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const findAcceptedSnapshot = vi.fn()
vi.mock("@/lib/config/accepted-config", () => ({
  findAcceptedSnapshot: (...args: unknown[]) => findAcceptedSnapshot(...args),
}))

import {
  createOperationalService,
  OperationalInputError,
  parseIncidentCursor,
} from "./operational-service"
import { encodeCursor } from "./pagination"

/** Minimal query-builder stub covering the calls enqueueTestNotification makes. */
function enqueueDatabase(
  options: { monitor?: { id: string } } = { monitor: { id: "monitor-1" } }
) {
  const monitorRows = options.monitor ? [options.monitor] : []
  return {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => monitorRows }) }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [{ id: "outbox-1" }],
        }),
      }),
    }),
  } as never
}

describe("operational service seams", () => {
  it("rejects malformed incident cursors before querying storage", () => {
    expect(() => parseIncidentCursor("not-a-cursor")).toThrow(
      OperationalInputError
    )
    expect(() =>
      parseIncidentCursor(
        encodeCursor({ sort: "not-a-date", id: "incident-1" })
      )
    ).toThrow("Cursor is invalid")
    expect(() =>
      parseIncidentCursor(
        encodeCursor({
          sort: "2026-07-18T00:00:00.000Z",
          id: "not-a-uuid",
        })
      )
    ).toThrow(OperationalInputError)
    try {
      parseIncidentCursor(
        encodeCursor({
          sort: "2026-07-18T00:00:00.000Z",
          id: "not-a-uuid",
        })
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_CURSOR" })
    }
  })

  it("accepts a valid timestamp+UUID incident cursor without touching storage", () => {
    const sort = "2026-07-18T12:00:00.000Z"
    const id = "11111111-1111-4111-8111-111111111111"
    expect(parseIncidentCursor(encodeCursor({ sort, id }))).toEqual({
      sort: new Date(sort),
      id,
    })
    expect(parseIncidentCursor(null)).toBeNull()
  })

  it("injects private-status retrieval without provider access", async () => {
    const service = createOperationalService({
      database: {} as never,
      getStatus: async () => ({
        overallState: "operational",
        source: "fixture",
      }),
    })
    await expect(service.getStatus()).resolves.toEqual({
      overallState: "operational",
      source: "fixture",
    })
  })

  it("enqueues an explicit recipient without ever reading the accepted config", async () => {
    findAcceptedSnapshot.mockRejectedValue(new Error("hash mismatch"))
    const service = createOperationalService({
      database: enqueueDatabase(),
      getStatus: async () => ({}),
    })
    await expect(
      service.enqueueTestNotification({
        recipient: "alerts@example.com",
        testId: "t1",
      })
    ).resolves.toEqual({ id: "outbox-1", state: "accepted" })
    expect(findAcceptedSnapshot).not.toHaveBeenCalled()
  })

  it("falls back to RECIPIENT_REQUIRED when the accepted config cannot be read", async () => {
    findAcceptedSnapshot.mockRejectedValue(new Error("hash mismatch"))
    const service = createOperationalService({
      database: enqueueDatabase(),
      getStatus: async () => ({}),
    })
    await expect(
      service.enqueueTestNotification({ testId: "t2" })
    ).rejects.toThrow(OperationalInputError)
    await expect(
      service.enqueueTestNotification({ testId: "t2" })
    ).rejects.toThrow("A configured recipient is required")
  })

  it("uses a default recipient from a healthy accepted config", async () => {
    findAcceptedSnapshot.mockResolvedValue({
      config: { settings: { defaultRecipients: ["default@example.com"] } },
    })
    const service = createOperationalService({
      database: enqueueDatabase(),
      getStatus: async () => ({}),
    })
    await expect(
      service.enqueueTestNotification({ testId: "t3" })
    ).resolves.toEqual({ id: "outbox-1", state: "accepted" })
  })
})
