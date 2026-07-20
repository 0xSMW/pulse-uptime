import { NextResponse } from "next/server";

import { isUuid } from "@/lib/ids/uuid";

export const API_VERSION = "v1" as const;

export type ApiMeta = {
  requestId: string;
  nextCursor?: string | null;
};

export function objectEnvelope<T>(kind: string, data: T, requestId: string) {
  return { apiVersion: API_VERSION, kind, data, meta: { requestId } };
}

export function listEnvelope<T>(
  kind: string,
  data: readonly T[],
  requestId: string,
  nextCursor: string | null,
) {
  return {
    apiVersion: API_VERSION,
    kind,
    data,
    meta: { requestId, nextCursor },
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details: Record<string, unknown> = {},
) {
  return {
    apiVersion: API_VERSION,
    kind: "Error" as const,
    error: { code, message, details, requestId },
  };
}

export function requestIdFrom(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && isUuid(supplied)
    ? supplied
    : `req_${crypto.randomUUID()}`;
}

export function apiJson<T>(body: T, init: ResponseInit = {}): NextResponse<T> {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Pulse-API-Version", API_VERSION);
  headers.set("X-Pulse-Supported-API-Versions", API_VERSION);
  headers.set("X-Pulse-Minimum-CLI-Version", minimumCliVersion());
  headers.set("X-Pulse-Latest-CLI-Version", latestCliVersion());
  return NextResponse.json(body, { ...init, headers });
}

export function apiError(
  requestId: string,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return apiJson(errorEnvelope(code, message, requestId, details), { status });
}

export function minimumCliVersion(): string {
  return process.env.PULSE_MINIMUM_CLI_VERSION ?? "0.1.0";
}

export function latestCliVersion(): string {
  return process.env.PULSE_LATEST_CLI_VERSION ?? "0.1.0";
}
