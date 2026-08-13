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
  uploadedByUserId: "user-1",
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
  vi.spyOn(databaseImageStore, "findAuthorized").mockResolvedValue(avatar)
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
    expect(databaseImageStore.findAuthorized).not.toHaveBeenCalled()
  })

  it("serves owned avatars without browser storage", async () => {
    const response = await imageRequest()
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("Content-Disposition")).toBe("inline")
  })

  it("hides another user's avatar", async () => {
    vi.mocked(databaseImageStore.findAuthorized).mockResolvedValue(null)
    const response = await imageRequest()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe("IMAGE_NOT_FOUND")
    expect(databaseImageStore.findAuthorized).toHaveBeenCalledWith(
      IMAGE_ID,
      "user-1"
    )
  })

  it("preserves authenticated branding preview access", async () => {
    vi.mocked(databaseImageStore.findAuthorized).mockResolvedValue({
      ...avatar,
      kind: "logo-light",
      uploadedByUserId: "user-2",
    })
    const response = await imageRequest()
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("serves a legacy owner-null avatar authorized by its current attachment", async () => {
    vi.mocked(databaseImageStore.findAuthorized).mockResolvedValue({
      ...avatar,
      uploadedByUserId: null,
    })
    const response = await imageRequest()
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(databaseImageStore.findAuthorized).toHaveBeenCalledWith(
      IMAGE_ID,
      "user-1"
    )
  })

  it("returns 404 for unknown ids", async () => {
    vi.mocked(databaseImageStore.findAuthorized).mockResolvedValue(null)
    const response = await imageRequest()
    expect(response.status).toBe(404)
    const payload = await response.json()
    expect(payload.error.code).toBe("IMAGE_NOT_FOUND")
  })

  it("returns 404 for malformed ids without querying", async () => {
    const response = await imageRequest("not-a-uuid")
    expect(response.status).toBe(404)
    expect(databaseImageStore.findAuthorized).not.toHaveBeenCalled()
  })
})
