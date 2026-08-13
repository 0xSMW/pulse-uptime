import "server-only"

import { and, eq, isNull, ne, or, sql } from "drizzle-orm"

import { db } from "@/lib/db/client"
import { imageKinds, images } from "@/lib/db/schema"
import { isUuid } from "@/lib/ids/uuid"

/**
 * Postgres-backed image storage. Rows are small (32–512 KB caps) and
 * ids rotate on re-upload, which is what makes the public asset route's
 * immutable caching safe.
 */

type ImageKind = (typeof imageKinds)[number]

export const MAX_IMAGE_BYTES = 512 * 1024
export const MAX_FAVICON_BYTES = 32 * 1024

/** SVGs are stored as-is and always served with a strict CSP. */
const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
] as const

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

export class ImageServiceError extends Error {
  constructor(
    readonly code:
      | "INVALID_KIND"
      | "INVALID_MIME_TYPE"
      | "INVALID_IMAGE"
      | "IMAGE_TOO_LARGE"
      | "OWNER_REQUIRED",
    message: string
  ) {
    super(message)
    this.name = "ImageServiceError"
  }
}

function isImageKind(value: string): value is ImageKind {
  return (imageKinds as readonly string[]).includes(value)
}

export function normalizeImageMimeType(value: string): ImageMimeType | null {
  const bare = value.split(";")[0]?.trim().toLowerCase() ?? ""
  const normalized = bare === "image/vnd.microsoft.icon" ? "image/x-icon" : bare
  return (IMAGE_MIME_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ImageMimeType)
    : null
}

function startsWith(
  bytes: Uint8Array,
  prefix: readonly number[],
  offset = 0
): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte)
}

/** Trust-but-verify: the declared type must match cheap content signatures. */
export function matchesImageSignature(
  mimeType: ImageMimeType,
  bytes: Uint8Array
): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      )
    case "image/x-icon":
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00])
    case "image/svg+xml": {
      const head = new TextDecoder("utf-8", { fatal: false }).decode(
        bytes.subarray(0, 1024)
      )
      return head.includes("<svg")
    }
  }
}

function maxBytesForKind(kind: ImageKind): number {
  return kind === "favicon" ? MAX_FAVICON_BYTES : MAX_IMAGE_BYTES
}

export interface ValidatedImageUpload {
  kind: ImageKind
  mimeType: ImageMimeType
}

export function validateImageUpload(
  kind: string,
  mimeType: string,
  bytes: Uint8Array
): ValidatedImageUpload {
  if (!isImageKind(kind)) {
    throw new ImageServiceError(
      "INVALID_KIND",
      `kind must be one of: ${imageKinds.join(", ")}`
    )
  }
  const normalizedMime = normalizeImageMimeType(mimeType)
  if (!normalizedMime) {
    throw new ImageServiceError(
      "INVALID_MIME_TYPE",
      "Images must be PNG, JPEG, SVG, WebP, or ICO"
    )
  }
  if (bytes.length === 0) {
    throw new ImageServiceError("INVALID_IMAGE", "The uploaded file is empty")
  }
  const cap = maxBytesForKind(kind)
  if (bytes.length > cap) {
    throw new ImageServiceError(
      "IMAGE_TOO_LARGE",
      `${kind} images must be at most ${Math.floor(cap / 1024)} KB`
    )
  }
  if (!matchesImageSignature(normalizedMime, bytes)) {
    throw new ImageServiceError(
      "INVALID_IMAGE",
      "The file content does not match its declared image type"
    )
  }
  return { kind, mimeType: normalizedMime }
}

export interface StoredImage {
  id: string
  uploadedByUserId: string | null
  kind: ImageKind
  mimeType: string
  bytes: Buffer
  byteSize: number
}

export interface ImageStore {
  insert: (input: {
    uploadedByUserId: string | null
    kind: ImageKind
    mimeType: string
    bytes: Buffer
    byteSize: number
    createdAt: Date
  }) => Promise<{ id: string }>
  find: (id: string) => Promise<StoredImage | null>
  findAuthorized: (id: string, userId: string) => Promise<StoredImage | null>
}

export interface ImageDependencies {
  store?: ImageStore
  now?: () => Date
}

export function avatarUploadLockKey(userId: string): string {
  return `avatar-upload:${userId}`
}

export async function createImage(
  input: {
    kind: string
    mimeType: string
    bytes: Buffer
    uploadedByUserId?: string | null
  },
  dependencies: ImageDependencies = {}
): Promise<{ id: string }> {
  const validated = validateImageUpload(input.kind, input.mimeType, input.bytes)
  if (validated.kind === "avatar" && !input.uploadedByUserId) {
    throw new ImageServiceError(
      "OWNER_REQUIRED",
      "Avatar images require an owning user"
    )
  }
  const store = dependencies.store ?? databaseImageStore
  return store.insert({
    uploadedByUserId: input.uploadedByUserId ?? null,
    kind: validated.kind,
    mimeType: validated.mimeType,
    bytes: input.bytes,
    byteSize: input.bytes.length,
    createdAt: dependencies.now?.() ?? new Date(),
  })
}

export async function findImage(
  id: string,
  dependencies: ImageDependencies = {}
): Promise<StoredImage | null> {
  if (!isUuid(id)) {
    return null
  }
  const store = dependencies.store ?? databaseImageStore
  return store.find(id)
}

export async function findAuthorizedImage(
  id: string,
  userId: string,
  dependencies: ImageDependencies = {}
): Promise<StoredImage | null> {
  if (!isUuid(id)) {
    return null
  }
  const store = dependencies.store ?? databaseImageStore
  return store.findAuthorized(id, userId)
}

const SVG_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'"

/** Binary response with correct type, inline disposition, and SVG sandboxing. */
export function imageResponse(
  image: StoredImage,
  cacheControl: string
): Response {
  const headers = new Headers({
    "Content-Type": image.mimeType,
    "Content-Length": String(image.byteSize),
    "Cache-Control": cacheControl,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  })
  if (image.mimeType === "image/svg+xml") {
    headers.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY)
  }
  return new Response(new Uint8Array(image.bytes), { status: 200, headers })
}

export const databaseImageStore: ImageStore = {
  async insert(input) {
    return db.transaction(async (tx) => {
      if (input.kind === "avatar" && input.uploadedByUserId) {
        // Serialize each user's uploads. A new pending avatar supersedes prior
        // unattached uploads so repeated changes cannot accumulate storage.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${avatarUploadLockKey(input.uploadedByUserId)}, 0))`
        )
        await tx.delete(images).where(
          and(
            eq(images.kind, "avatar"),
            eq(images.uploadedByUserId, input.uploadedByUserId),
            sql`not exists (
              select 1 from admin_users
              where admin_users.avatar_image_id = ${images.id}
            )`
          )
        )
      }
      const [row] = await tx
        .insert(images)
        .values(input)
        .returning({ id: images.id })
      return { id: row!.id }
    })
  },
  async find(id) {
    const [row] = await db
      .select({
        id: images.id,
        uploadedByUserId: images.uploadedByUserId,
        kind: images.kind,
        mimeType: images.mimeType,
        bytes: images.bytes,
        byteSize: images.byteSize,
      })
      .from(images)
      .where(eq(images.id, id))
      .limit(1)
    return row ?? null
  },
  async findAuthorized(id, userId) {
    const [row] = await db
      .select({
        id: images.id,
        uploadedByUserId: images.uploadedByUserId,
        kind: images.kind,
        mimeType: images.mimeType,
        bytes: images.bytes,
        byteSize: images.byteSize,
      })
      .from(images)
      .where(
        and(
          eq(images.id, id),
          or(
            ne(images.kind, "avatar"),
            eq(images.uploadedByUserId, userId),
            and(
              isNull(images.uploadedByUserId),
              sql`exists (
                select 1 from admin_users
                where admin_users.id = ${userId}
                  and admin_users.avatar_image_id = ${images.id}
              )`
            )
          )
        )
      )
      .limit(1)
    return row ?? null
  },
}
