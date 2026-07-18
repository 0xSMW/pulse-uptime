export type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> };

export type SettingsGroup = { id: string; name: string; monitorCount: number };

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: Record<string, unknown> } };

export class SettingsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  url: string,
  init: RequestInit = {},
  mutation = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (mutation) headers.set("Idempotency-Key", crypto.randomUUID());

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      // Preserve the status-based fallback when a proxy returns a non-JSON body.
    }
    throw new SettingsApiError(
      envelope.error?.message || `Request failed (${response.status})`,
      response.status,
      envelope.error?.code,
      envelope.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function messageForError(error: unknown): string {
  if (error instanceof SettingsApiError && error.code === "CONFIG_VERSION_CONFLICT") {
    return "Configuration changed elsewhere. Reload before saving.";
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

export function generatedMonitorId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55)
    .replace(/-+$/g, "");
  const prefix = base || "monitor";
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 64);
}

export function generatedGroupId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55)
    .replace(/-+$/g, "");
  const prefix = base || "group";
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 64);
}

export function sortSettingsGroups(groups: readonly SettingsGroup[]): SettingsGroup[] {
  return [...groups].sort((left, right) => left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }));
}

export function groupDeleteBlockedCount(error: unknown): number | null {
  if (!(error instanceof SettingsApiError) || error.code !== "GROUP_NOT_EMPTY") return null;
  const count = error.details?.monitorCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

export function expiryFromDays(days: 30 | 90 | 365, now = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
