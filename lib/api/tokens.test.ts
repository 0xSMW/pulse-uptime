import { describe, expect, it } from "vitest";

import {
  createBearerToken,
  createDeviceCode,
  credentialDerivationContext,
  deriveBearerToken,
  deriveDeviceCode,
  digestBearerToken,
  digestDeviceCode,
  parseBearerAuthorization,
} from "./tokens";

describe("bearer token secrets", () => {
  it("generates 256-bit random secrets and stores deterministic digests", () => {
    const hashKey = "test-key-with-at-least-32-characters";
    const token = createBearerToken(undefined, hashKey);
    expect(token.raw).toMatch(/^pulse_live_[A-Za-z0-9_-]{43}$/);
    expect(token.prefix).not.toBe(token.raw);
    expect(token.digest).toHaveLength(32);
    expect(token.digest.equals(digestBearerToken(token.raw, hashKey))).toBe(true);
    expect(token.digest.equals(digestBearerToken(`${token.raw}x`, hashKey))).toBe(false);
    expect(token.digest.equals(digestBearerToken(token.raw, `${hashKey}-different`))).toBe(false);
  });

  it("parses only a complete bearer authorization value", () => {
    expect(parseBearerAuthorization("Bearer pulse_live_secret")).toBe("pulse_live_secret");
    expect(parseBearerAuthorization("bearer\tpulse_cli_secret")).toBe("pulse_cli_secret");
    expect(parseBearerAuthorization("Basic abc")).toBeNull();
    expect(parseBearerAuthorization("Bearer one two")).toBeNull();
  });

  it("uses a separate keyed digest for device codes", () => {
    process.env.DEVICE_AUTH_SECRET = "device-secret-with-at-least-32-characters";
    process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters";
    const code = createDeviceCode();
    expect(code.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code.digest).toHaveLength(32);
    expect(code.digest.equals(digestDeviceCode(code.raw))).toBe(true);
    expect(code.digest.equals(digestBearerToken(code.raw))).toBe(false);
  });

  it("derives replay-safe credentials without retaining raw values", () => {
    process.env.DEVICE_AUTH_SECRET = "device-secret-with-at-least-32-characters";
    process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters";
    const firstToken = deriveBearerToken("api-token:human:1:key");
    const replayedToken = deriveBearerToken("api-token:human:1:key");
    const differentToken = deriveBearerToken("api-token:human:1:other-key");
    const firstCode = deriveDeviceCode("device:ip:key");
    const replayedCode = deriveDeviceCode("device:ip:key");
    expect(replayedToken).toEqual(firstToken);
    expect(differentToken.raw).not.toBe(firstToken.raw);
    expect(replayedCode).toEqual(firstCode);
    expect(firstCode.digest.equals(digestDeviceCode(firstCode.raw))).toBe(true);
  });

  it("binds replay credentials to canonical request identity and the persisted operation", () => {
    process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters";
    const base = {
      kind: "api-token",
      principalKey: "human:1",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      body: { name: "Deploy", scopes: ["status:read"], expiresAt: "2027-01-01T00:00:00.000Z" },
      operationId: "00000000-0000-4000-8000-000000000010",
    };
    const first = deriveBearerToken(credentialDerivationContext(base));
    const replay = deriveBearerToken(credentialDerivationContext({ ...base, body: { expiresAt: "2027-01-01T00:00:00.000Z", scopes: ["status:read"], name: "Deploy" } }));
    const changedBody = deriveBearerToken(credentialDerivationContext({ ...base, body: { ...base.body, name: "Different" } }));
    const afterPersistenceExpiry = deriveBearerToken(credentialDerivationContext({
      ...base,
      operationId: "00000000-0000-4000-8000-000000000011",
    }));
    expect(replay).toEqual(first);
    expect(changedBody.raw).not.toBe(first.raw);
    expect(afterPersistenceExpiry.raw).not.toBe(first.raw);
  });
});
