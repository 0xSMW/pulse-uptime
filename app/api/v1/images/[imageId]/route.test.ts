import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))

import { databaseImageStore, type StoredImage } from "@/lib/api/images"
import { type ApiContext, authorize } from "@/lib/api/middleware"

import { GET } from "./route"

const IMAGE_ID = "55555555-5555-4555-8555-555555555555"

const humanContext: ApiContext = {
  principal: {
    type: "human",
    role: "admin",
    id: "user-1",
    sessionId: "session-1",
    email: "admin@example.com",
    scopes: [],
  },
  principalKey: "human:user-1",
  requestId: "req_image",
}

const avatar: StoredImage = {
  id: IMAGE_ID,
  kind: "avatar",
  mimeType: "image/png",
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  byteSize: 4,
}

function imageRequest(id = IMAGE_ID) {
  return GET(new Request(`https://pulse.test/api/v1/images/${id}`), {
    params: Promise.resolve({ imageId: id }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authorize).mockResolvedValue(humanContext)
  vi.spyOn(databaseImageStore, "find").mockResolvedValue(avatar)
})

describe("GET /api/v1/images/{imageId}", () => {
  it("refuses bearer principals with SESSION_REQUIRED", async () => {
    vi.mocked(authorize).mockResolvedValue({
      ...humanContext,
      principal: {
        type: "api_token",
        id: "tok-1",
        name: "agent",
        scopes: ["config:write"],
        expiresAt: new Date(),
      },
    })
    const response = await imageRequest()
    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error.code).toBe("SESSION_REQUIRED")
    expect(databaseImageStore.find).not.toHaveBeenCalled()
  })

  it("serves any stored kind to the dashboard with a short private cache", async () => {
    const response = await imageRequest()
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300")
    expect(response.headers.get("Content-Disposition")).toBe("inline")
  })

  it("returns 404 for unknown ids", async () => {
    vi.mocked(databaseImageStore.find).mockResolvedValue(null)
    const response = await imageRequest()
    expect(response.status).toBe(404)
    const payload = await response.json()
    expect(payload.error.code).toBe("IMAGE_NOT_FOUND")
  })

  it("returns 404 for malformed ids without querying", async () => {
    const response = await imageRequest("not-a-uuid")
    expect(response.status).toBe(404)
    expect(databaseImageStore.find).not.toHaveBeenCalled()
  })
})
