import { Buffer } from "node:buffer"

export type CursorValue = { sort: string; id: string }

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

export function decodeCursor(value: string | null): CursorValue | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown
    if (!parsed || typeof parsed !== "object") {
      return null
    }
    const cursor = parsed as Partial<CursorValue>
    return typeof cursor.sort === "string" && typeof cursor.id === "string"
      ? { sort: cursor.sort, id: cursor.id }
      : null
  } catch {
    return null
  }
}

export function pageLimit(value: string | null, fallback = 50): number | null {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : null
}
