import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/api/live-authority", () => ({ hasLiveScope: vi.fn() }))
vi.mock("@/lib/api/idempotency", () => ({
  executeIdempotent: vi.fn(
    async ({ work }: { work: (tx: unknown) => Promise<unknown> }) => ({
      ...((await work({ rollback: vi.fn() })) as object),
      replayed: false,
    })
  ),
}))
vi.mock("@/lib/api/operational-service", () => ({
  OperationalInputError: class OperationalInputError extends Error {},
  operationalService: { enqueueTestNotification: vi.fn() },
}))

import { hasLiveScope } from "@/lib/api/live-authority"
import { type ApiContext, authorize } from "@/lib/api/middleware"
import { operationalService } from "@/lib/api/operational-service"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "human",
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
    role: "admin",
    scopes: ["notifications:test"],
  },
  principalKey: "human:11111111-1111-4111-8111-111111111111",
  requestId: "req_notification",
}

beforeEach(() => {
  vi.mocked(authorize).mockReset().mockResolvedValue(context)
  vi.mocked(hasLiveScope).mockReset().mockResolvedValue(true)
  vi.mocked(operationalService.enqueueTestNotification)
    .mockReset()
    .mockResolvedValue({ id: "notification-1" } as never)
})

describe("POST /api/v1/notifications/test temporal authority", () => {
  it("denies a caller revoked while its JSON body is still streaming", async () => {
    let finishBody: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"recipient":"'))
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode('alerts@example.com"}'))
          controller.close()
        }
      },
    })
    const request = new Request(
      "https://pulse.test/api/v1/notifications/test",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }
    )

    const pending = POST(request)
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    vi.mocked(hasLiveScope).mockResolvedValue(false)
    finishBody?.()
    const response = await pending

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("SCOPE_DENIED")
    expect(hasLiveScope).toHaveBeenCalledWith(
      expect.objectContaining({ rollback: expect.any(Function) }),
      context.principal,
      "notifications:test"
    )
    expect(operationalService.enqueueTestNotification).not.toHaveBeenCalled()
  })

  it("enqueues when authority remains live at the transaction boundary", async () => {
    const request = new Request(
      "https://pulse.test/api/v1/notifications/test",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ recipient: "alerts@example.com" }),
      }
    )

    const response = await POST(request)

    expect(response.status).toBe(202)
    expect(operationalService.enqueueTestNotification).toHaveBeenCalledOnce()
  })
})
