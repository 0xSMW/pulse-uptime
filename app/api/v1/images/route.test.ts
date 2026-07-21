import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))

import { apiError } from "@/lib/api/envelopes"
import { databaseImageStore, MAX_IMAGE_BYTES } from "@/lib/api/images"
import { type ApiContext, authorize } from "@/lib/api/middleware"

import { POST } from "./route"

const context: ApiContext = {
  principal: {
    type: "human",
    id: "user-1",
    email: "admin@example.com",
    scopes: ["config:write"],
  },
  principalKey: "human:user-1",
  requestId: "req_upload",
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])

function uploadRequest(parts: { file?: File; kind?: string }) {
  const form = new FormData()
  if (parts.file) {
    form.append("file", parts.file)
  }
  if (parts.kind !== undefined) {
    form.append("kind", parts.kind)
  }
  return new Request("https://pulse.test/api/v1/images", {
    method: "POST",
    body: form,
  })
}

function pngFile(bytes: Buffer = PNG, type = "image/png") {
  return new File([new Uint8Array(bytes)], "logo.png", { type })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authorize).mockResolvedValue(context)
  vi.spyOn(databaseImageStore, "insert").mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
  })
})

describe("POST /api/v1/images", () => {
  it("requires the config:write scope (session or token)", async () => {
    await POST(uploadRequest({ file: pngFile(), kind: "avatar" }))
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), {
      scope: "config:write",
    })
  })

  it("returns the authorization failure untouched", async () => {
    vi.mocked(authorize).mockResolvedValue(
      apiError("req_denied", 403, "SCOPE_DENIED", "denied")
    )
    const response = await POST(
      uploadRequest({ file: pngFile(), kind: "avatar" })
    )
    expect(response.status).toBe(403)
    expect(databaseImageStore.insert).not.toHaveBeenCalled()
  })

  it("stores a valid upload and returns the id in an envelope", async () => {
    const response = await POST(
      uploadRequest({ file: pngFile(), kind: "avatar" })
    )
    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload.kind).toBe("Image")
    expect(payload.data).toEqual({ id: "44444444-4444-4444-8444-444444444444" })
    expect(databaseImageStore.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "avatar",
        mimeType: "image/png",
        byteSize: PNG.length,
      })
    )
  })

  it("rejects non-multipart bodies and missing fields", async () => {
    const raw = new Request("https://pulse.test/api/v1/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect((await POST(raw)).status).toBe(400)
    expect((await POST(uploadRequest({ kind: "avatar" }))).status).toBe(400)
    const noKind = await POST(uploadRequest({ file: pngFile() }))
    expect(noKind.status).toBe(400)
    expect((await noKind.json()).error.code).toBe("INVALID_FORM")
  })

  it("rejects unknown kinds and disallowed mime types", async () => {
    const badKind = await POST(
      uploadRequest({ file: pngFile(), kind: "banner" })
    )
    expect(badKind.status).toBe(400)
    expect((await badKind.json()).error.code).toBe("INVALID_KIND")

    const badMime = await POST(
      uploadRequest({ file: pngFile(PNG, "image/gif"), kind: "avatar" })
    )
    expect(badMime.status).toBe(400)
    expect((await badMime.json()).error.code).toBe("INVALID_MIME_TYPE")
  })

  it("rejects content that does not match the declared type", async () => {
    const spoofed = new File(
      [new Uint8Array(Buffer.from("<svg onload=alert(1)>"))],
      "logo.png",
      { type: "image/png" }
    )
    const response = await POST(
      uploadRequest({ file: spoofed, kind: "logo-light" })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("INVALID_IMAGE")
  })

  it("enforces the 512 KB general cap before buffering", async () => {
    const oversized = pngFile(
      Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
    )
    const response = await POST(
      uploadRequest({ file: oversized, kind: "logo-light" })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("IMAGE_TOO_LARGE")
    expect(databaseImageStore.insert).not.toHaveBeenCalled()
  })

  it("enforces the 32 KB favicon cap", async () => {
    const icoBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0x00]),
      Buffer.alloc(32 * 1024),
    ])
    const favicon = new File([new Uint8Array(icoBytes)], "favicon.ico", {
      type: "image/x-icon",
    })
    const response = await POST(
      uploadRequest({ file: favicon, kind: "favicon" })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("IMAGE_TOO_LARGE")
  })
})
