import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { imageKinds, images } from "@/lib/db/schema";

/**
 * Postgres-backed image storage (§2.4). Rows are small (32–512 KB caps) and
 * ids rotate on re-upload, which is what makes the public asset route's
 * immutable caching safe.
 */

export type ImageKind = (typeof imageKinds)[number];

export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_FAVICON_BYTES = 32 * 1024;

/** SVGs are stored as-is and always served with a strict CSP. */
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export class ImageServiceError extends Error {
  constructor(
    readonly code: "INVALID_KIND" | "INVALID_MIME_TYPE" | "INVALID_IMAGE" | "IMAGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "ImageServiceError";
  }
}

export function isImageKind(value: string): value is ImageKind {
  return (imageKinds as readonly string[]).includes(value);
}

export function normalizeImageMimeType(value: string): ImageMimeType | null {
  const bare = value.split(";")[0]?.trim().toLowerCase() ?? "";
  const normalized = bare === "image/vnd.microsoft.icon" ? "image/x-icon" : bare;
  return (IMAGE_MIME_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ImageMimeType)
    : null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/** Trust-but-verify: the declared type must match cheap content signatures. */
export function matchesImageSignature(mimeType: ImageMimeType, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "image/x-icon":
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
    case "image/svg+xml": {
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
      return head.includes("<svg");
    }
  }
}

export function maxBytesForKind(kind: ImageKind): number {
  return kind === "favicon" ? MAX_FAVICON_BYTES : MAX_IMAGE_BYTES;
}

export type ValidatedImageUpload = { kind: ImageKind; mimeType: ImageMimeType };

export function validateImageUpload(kind: string, mimeType: string, bytes: Uint8Array): ValidatedImageUpload {
  if (!isImageKind(kind)) {
    throw new ImageServiceError("INVALID_KIND", `kind must be one of: ${imageKinds.join(", ")}`);
  }
  const normalizedMime = normalizeImageMimeType(mimeType);
  if (!normalizedMime) {
    throw new ImageServiceError("INVALID_MIME_TYPE", "Images must be PNG, JPEG, SVG, WebP, or ICO");
  }
  if (bytes.length === 0) {
    throw new ImageServiceError("INVALID_IMAGE", "The uploaded file is empty");
  }
  const cap = maxBytesForKind(kind);
  if (bytes.length > cap) {
    throw new ImageServiceError("IMAGE_TOO_LARGE", `${kind} images must be at most ${Math.floor(cap / 1024)} KB`);
  }
  if (!matchesImageSignature(normalizedMime, bytes)) {
    throw new ImageServiceError("INVALID_IMAGE", "The file content does not match its declared image type");
  }
  return { kind, mimeType: normalizedMime };
}

export type StoredImage = {
  id: string;
  kind: ImageKind;
  mimeType: string;
  bytes: Buffer;
  byteSize: number;
};

export interface ImageStore {
  insert(input: {
    kind: ImageKind;
    mimeType: string;
    bytes: Buffer;
    byteSize: number;
    createdAt: Date;
  }): Promise<{ id: string }>;
  find(id: string): Promise<StoredImage | null>;
}

export type ImageDependencies = {
  store?: ImageStore;
  now?: () => Date;
};

export async function createImage(
  input: { kind: string; mimeType: string; bytes: Buffer },
  dependencies: ImageDependencies = {},
): Promise<{ id: string }> {
  const validated = validateImageUpload(input.kind, input.mimeType, input.bytes);
  const store = dependencies.store ?? databaseImageStore;
  return store.insert({
    kind: validated.kind,
    mimeType: validated.mimeType,
    bytes: input.bytes,
    byteSize: input.bytes.length,
    createdAt: dependencies.now?.() ?? new Date(),
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getImage(
  id: string,
  dependencies: ImageDependencies = {},
): Promise<StoredImage | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const store = dependencies.store ?? databaseImageStore;
  return store.find(id);
}

const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** Binary response with correct type, inline disposition, and SVG sandboxing. */
export function imageResponse(image: StoredImage, cacheControl: string): Response {
  const headers = new Headers({
    "Content-Type": image.mimeType,
    "Content-Length": String(image.byteSize),
    "Cache-Control": cacheControl,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  });
  if (image.mimeType === "image/svg+xml") {
    headers.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
  }
  return new Response(new Uint8Array(image.bytes), { status: 200, headers });
}

export const databaseImageStore: ImageStore = {
  async insert(input) {
    const [row] = await db.insert(images).values(input).returning({ id: images.id });
    return { id: row!.id };
  },
  async find(id) {
    const [row] = await db
      .select({
        id: images.id,
        kind: images.kind,
        mimeType: images.mimeType,
        bytes: images.bytes,
        byteSize: images.byteSize,
      })
      .from(images)
      .where(eq(images.id, id))
      .limit(1);
    return row ?? null;
  },
};
