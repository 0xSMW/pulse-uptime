export type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> };

type ErrorEnvelope = { error?: { code?: string; message?: string } };

export class SettingsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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
    .slice(0, 55);
  const prefix = base || "monitor";
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 64);
}

export function expiryFromDays(days: 30 | 90 | 365, now = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
