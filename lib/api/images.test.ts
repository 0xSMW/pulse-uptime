import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }))

import { PgDialect } from "drizzle-orm/pg-core"
import { db } from "@/lib/db/client"
import {
  avatarUploadLockKey,
  createImage,
  databaseImageStore,
  findImage,
  ImageServiceError,
  type ImageStore,
  imageResponse,
  MAX_FAVICON_BYTES,
  MAX_IMAGE_BYTES,
  matchesImageSignature,
  normalizeImageMimeType,
  validateImageUpload,
} from "./images"

describe("avatarUploadLockKey", () => {
  it("coordinates upload replacement and profile attachment per owner", () => {
    expect(avatarUploadLockKey("user-1")).toBe("avatar-upload:user-1")
    expect(avatarUploadLockKey("user-2")).not.toBe(
      avatarUploadLockKey("user-1")
    )
  })
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64),
])
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(32),
])
const ICO = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x01, 0x00]),
  Buffer.alloc(32),
])
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'
)

describe("normalizeImageMimeType", () => {
  it("normalizes case, parameters, and the legacy ICO type", () => {
    expect(normalizeImageMimeType("image/PNG")).toBe("image/png")
    expect(normalizeImageMimeType("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml"
    )
    expect(normalizeImageMimeType("image/vnd.microsoft.icon")).toBe(
      "image/x-icon"
    )
    expect(normalizeImageMimeType("image/gif")).toBeNull()
    expect(normalizeImageMimeType("text/html")).toBeNull()
  })
})

describe("matchesImageSignature", () => {
  it("verifies content signatures for each allowed type", () => {
    expect(matchesImageSignature("image/png", PNG)).toBe(true)
    expect(matchesImageSignature("image/jpeg", JPEG)).toBe(true)
    expect(matchesImageSignature("image/webp", WEBP)).toBe(true)
    expect(matchesImageSignature("image/x-icon", ICO)).toBe(true)
    expect(matchesImageSignature("image/svg+xml", SVG)).toBe(true)
    expect(matchesImageSignature("image/png", JPEG)).toBe(false)
    expect(matchesImageSignature("image/svg+xml", PNG)).toBe(false)
    expect(
      matchesImageSignature("image/webp", Buffer.from("RIFFxxxxWAVE"))
    ).toBe(false)
  })
})

describe("validateImageUpload", () => {
  it("accepts a valid upload and returns the normalized type", () => {
    expect(validateImageUpload("avatar", "image/PNG", PNG)).toEqual({
      kind: "avatar",
      mimeType: "image/png",
    })
  })

  it("rejects unknown kinds", () => {
    expect(() => validateImageUpload("banner", "image/png", PNG)).toThrow(
      ImageServiceError
    )
    try {
      validateImageUpload("banner", "image/png", PNG)
    } catch (error) {
      expect((error as ImageServiceError).code).toBe("INVALID_KIND")
    }
  })

  it("rejects disallowed mime types and empty files", () => {
    expect(() => validateImageUpload("avatar", "image/gif", PNG)).toThrow(
      ImageServiceError
    )
    expect(() =>
      validateImageUpload("avatar", "image/png", Buffer.alloc(0))
    ).toThrow(ImageServiceError)
  })

  it("rejects content that does not match the declared type", () => {
    try {
      validateImageUpload("avatar", "image/png", SVG)
      expect.unreachable()
    } catch (error) {
      expect((error as ImageServiceError).code).toBe("INVALID_IMAGE")
    }
  })

  it("caps general kinds at 512 KB and favicons at 32 KB", () => {
    const bigPng = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
    expect(() =>
      validateImageUpload("logo-light", "image/png", bigPng)
    ).toThrow(/512 KB/)
    const okLogo = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_IMAGE_BYTES - PNG.length),
    ])
    expect(validateImageUpload("logo-light", "image/png", okLogo).kind).toBe(
      "logo-light"
    )

    const bigFavicon = Buffer.concat([ICO, Buffer.alloc(MAX_FAVICON_BYTES)])
    expect(() =>
      validateImageUpload("favicon", "image/x-icon", bigFavicon)
    ).toThrow(/32 KB/)
    const okFavicon = Buffer.concat([
      ICO,
      Buffer.alloc(MAX_FAVICON_BYTES - ICO.length),
    ])
    expect(validateImageUpload("favicon", "image/x-icon", okFavicon).kind).toBe(
      "favicon"
    )
  })
})

describe("createImage", () => {
  it("stores validated bytes with size and timestamp", async () => {
    const store: ImageStore = {
      insert: vi.fn().mockResolvedValue({ id: "img-1" }),
      find: vi.fn(),
      findAuthorized: vi.fn(),
    }
    const now = new Date("2026-07-18T00:00:00Z")
    await expect(
      createImage(
        {
          kind: "avatar",
          mimeType: "image/png",
          bytes: PNG,
          uploadedByUserId: "user-1",
        },
        { store, now: () => now }
      )
    ).resolves.toEqual({ id: "img-1" })
    expect(store.insert).toHaveBeenCalledWith({
      uploadedByUserId: "user-1",
      kind: "avatar",
      mimeType: "image/png",
      bytes: PNG,
      byteSize: PNG.length,
      createdAt: now,
    })
  })

  it("does not touch the store for invalid uploads", async () => {
    const store: ImageStore = {
      insert: vi.fn(),
      find: vi.fn(),
      findAuthorized: vi.fn(),
    }
    await expect(
      createImage(
        { kind: "avatar", mimeType: "image/gif", bytes: PNG },
        { store }
      )
    ).rejects.toBeInstanceOf(ImageServiceError)
    expect(store.insert).not.toHaveBeenCalled()
  })

  it("requires an owner for avatar uploads", async () => {
    const store: ImageStore = {
      insert: vi.fn(),
      find: vi.fn(),
      findAuthorized: vi.fn(),
    }
    await expect(
      createImage(
        { kind: "avatar", mimeType: "image/png", bytes: PNG },
        { store }
      )
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" })
    expect(store.insert).not.toHaveBeenCalled()
  })
})

describe("databaseImageStore avatar replacement", () => {
  it("serializes, removes only same-owner pending avatars, then inserts", async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const where = vi.fn().mockResolvedValue(undefined)
    const deleteFrom = vi.fn().mockReturnValue({ where })
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: "44444444-4444-4444-8444-444444444444" }])
    const values = vi.fn().mockReturnValue({ returning })
    const insert = vi.fn().mockReturnValue({ values })
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) =>
      callback({ execute, delete: deleteFrom, insert } as never)
    )

    await databaseImageStore.insert({
      uploadedByUserId: "11111111-1111-4111-8111-111111111111",
      kind: "avatar",
      mimeType: "image/png",
      bytes: PNG,
      byteSize: PNG.length,
      createdAt: new Date("2026-07-18T00:00:00Z"),
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(where).toHaveBeenCalledOnce()
    const condition = where.mock.calls[0]![0]
    const rendered = new PgDialect().sqlToQuery(condition.getSQL())
    expect(rendered.sql).toContain('"images"."kind" = $1')
    expect(rendered.sql).toContain('"images"."uploaded_by_user_id" = $2')
    expect(rendered.sql).toContain("admin_users.avatar_image_id")
    expect(rendered.params.slice(0, 2)).toEqual([
      "avatar",
      "11111111-1111-4111-8111-111111111111",
    ])
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      where.mock.invocationCallOrder[0]!
    )
    expect(where.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]!
    )
  })
})

describe("findImage", () => {
  it("short-circuits non-UUID ids without querying", async () => {
    const store: ImageStore = {
      insert: vi.fn(),
      find: vi.fn(),
      findAuthorized: vi.fn(),
    }
    await expect(findImage("../etc/passwd", { store })).resolves.toBeNull()
    expect(store.find).not.toHaveBeenCalled()
  })
})

describe("imageResponse", () => {
  const image = {
    id: "img-1",
    uploadedByUserId: null,
    kind: "logo-light" as const,
    mimeType: "image/png",
    bytes: PNG,
    byteSize: PNG.length,
  }

  it("serves bytes inline with the stored content type and cache policy", async () => {
    const response = imageResponse(
      image,
      "public, max-age=31536000, s-maxage=31536000, immutable"
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable"
    )
    expect(response.headers.get("Content-Disposition")).toBe("inline")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Security-Policy")).toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it("adds the strict CSP for SVG content", () => {
    const response = imageResponse(
      { ...image, mimeType: "image/svg+xml", bytes: SVG, byteSize: SVG.length },
      "private, max-age=300"
    )
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
  })
})
