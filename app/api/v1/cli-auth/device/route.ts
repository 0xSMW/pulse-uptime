import { isIP } from "node:net";

import { apiError, apiJson, objectEnvelope, requestIdFrom } from "@/lib/api/envelopes";
import { executeIdempotent, IdempotencyError } from "@/lib/api/idempotency";
import { enforceRateLimit, sourceIpKey } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route";
import { DeviceAuthorizationError, startDeviceAuthorization } from "@/lib/api/device-authorization";
import { credentialDerivationContext, deriveDeviceCode } from "@/lib/api/tokens";

const DEVICE_START_LIMIT = { routeKey: "cli-device-start", limit: 10, windowSeconds: 10 * 60 };

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const rate = await enforceRateLimit(sourceIpKey(request), DEVICE_START_LIMIT);
  if (!rate.allowed) return limited(requestId, rate.retryAfterSeconds);
  try {
    const input = validateDeviceInput(await request.json());
    const ipKey = sourceIpKey(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const origin = new URL(request.url).origin;
    const verificationUri = `${origin}/cli/authorize`;
    const result = await executeIdempotent<DeviceAuthorizationData>({
      request,
      principalKey: ipKey,
      routeKey: "cli-device-start",
      body: input,
      work: async ({ operationId }) => {
        const credential = deriveDeviceCode(credentialDerivationContext({
          kind: "device-authorization",
          principalKey: ipKey,
          idempotencyKey,
          body: input,
          operationId,
        }));
        const authorization = await startDeviceAuthorization({
          ...input,
          requestIp: requestSourceIp(request),
          deviceCredential: credential,
        });
        return {
          status: 201,
          body: {
            ...authorization,
            verificationUri,
            verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(authorization.userCode)}`,
          },
        };
      },
      persistBody: (body) => ({
        userCode: body.userCode,
        expiresIn: body.expiresIn,
        interval: body.interval,
        verificationUri: body.verificationUri,
        verificationUriComplete: body.verificationUriComplete,
      }),
      replayBody: (stored, { operationId }) => ({
        ...(stored as Omit<DeviceAuthorizationData, "deviceCode">),
        deviceCode: deriveDeviceCode(credentialDerivationContext({
          kind: "device-authorization",
          principalKey: ipKey,
          idempotencyKey,
          body: input,
          operationId,
        })).raw,
      }),
    });
    return apiJson(objectEnvelope("DeviceAuthorization", result.body, requestId), { status: result.status });
  } catch (error) {
    if (error instanceof DeviceAuthorizationError) {
      return apiError(requestId, 400, error.code, error.message);
    }
    if (error instanceof InvalidDeviceRequest) return apiError(requestId, 400, "INVALID_DEVICE_REQUEST", error.message);
    return routeError(error, requestId);
  }
}

function validateDeviceInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidDeviceRequest("Device details are required");
  const value = input as Record<string, unknown>;
  const names = ["clientName", "installationKey", "installationName", "clientVersion", "platform", "architecture", "scopeProfile"] as const;
  if (Object.keys(value).some((key) => !names.includes(key as (typeof names)[number]))) {
    throw new InvalidDeviceRequest("Device details contain unsupported fields");
  }
  for (const name of names) {
    if (typeof value[name] !== "string" || !value[name].trim() || value[name].length > 200) {
      throw new InvalidDeviceRequest(`Invalid ${name}`);
    }
  }
  if (value.clientName !== "pulsectl" || value.scopeProfile !== "administrator") {
    throw new InvalidDeviceRequest("Unsupported client or scope profile");
  }
  return Object.fromEntries(names.map((name) => [name, (value[name] as string).trim()])) as Record<(typeof names)[number], string>;
}

function limited(requestId: string, retryAfter: number) {
  const response = apiError(requestId, 429, "RATE_LIMITED", "Too many requests");
  response.headers.set("Retry-After", String(retryAfter));
  return response;
}

class InvalidDeviceRequest extends Error {}

type DeviceAuthorizationData = {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  verificationUri: string;
  verificationUriComplete: string;
};

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED", "A UUID Idempotency-Key is required");
  }
  return key;
}

function requestSourceIp(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return isIP(ip) ? ip : null;
}
