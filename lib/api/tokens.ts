import { createHmac, randomBytes } from "node:crypto";

import { canonicalSerialize } from "@/lib/config/canonical";

export const API_TOKEN_PREFIX = "pulse_live_";
export const CLI_SESSION_PREFIX = "pulse_cli_";
const TOKEN_BYTES = 32;

export function digestBearerToken(
  raw: string,
  hashKey = apiTokenHashKey(),
): Buffer {
  return createHmac("sha256", hashKey).update(raw, "utf8").digest();
}

export function createBearerToken(
  prefix = API_TOKEN_PREFIX,
  hashKey = apiTokenHashKey(),
): {
  raw: string;
  prefix: string;
  digest: Buffer;
} {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const raw = `${prefix}${secret}`;
  return {
    raw,
    prefix: raw.slice(0, prefix.length + 8),
    digest: digestBearerToken(raw, hashKey),
  };
}

export function deriveBearerToken(
  context: string,
  prefix = API_TOKEN_PREFIX,
  hashKey = apiTokenHashKey(),
): { raw: string; prefix: string; digest: Buffer } {
  const secret = createHmac("sha256", hashKey)
    .update(`pulse-bearer-v1\0${context}`, "utf8")
    .digest("base64url");
  const raw = `${prefix}${secret}`;
  return { raw, prefix: raw.slice(0, prefix.length + 8), digest: digestBearerToken(raw, hashKey) };
}

function apiTokenHashKey(): string {
  const key = process.env.API_TOKEN_HASH_KEY;
  if (!key || key.length < 32) {
    throw new Error("API_TOKEN_HASH_KEY must contain at least 32 characters");
  }
  return key;
}

export function digestDeviceCode(raw: string): Buffer {
  const key = process.env.DEVICE_AUTH_SECRET;
  if (!key || key.length < 32) {
    throw new Error("DEVICE_AUTH_SECRET must contain at least 32 characters");
  }
  return createHmac("sha256", key).update(raw, "utf8").digest();
}

export function createDeviceCode(): { raw: string; digest: Buffer } {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, digest: digestDeviceCode(raw) };
}

export function deriveDeviceCode(context: string): { raw: string; digest: Buffer } {
  const key = process.env.DEVICE_AUTH_SECRET;
  if (!key || key.length < 32) {
    throw new Error("DEVICE_AUTH_SECRET must contain at least 32 characters");
  }
  const raw = createHmac("sha256", key)
    .update(`pulse-device-v1\0${context}`, "utf8")
    .digest("base64url");
  return { raw, digest: digestDeviceCode(raw) };
}

export function credentialDerivationContext(input: {
  kind: string;
  principalKey: string;
  idempotencyKey: string;
  body: unknown;
  operationId: string;
}): string {
  return [
    input.kind,
    input.principalKey,
    input.idempotencyKey,
    canonicalSerialize(input.body),
    input.operationId,
  ].join("\n");
}

export function parseBearerAuthorization(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}
