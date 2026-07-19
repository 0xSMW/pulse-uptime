import { apiError, apiJson, objectEnvelope, requestIdFrom } from "@/lib/api/envelopes";
import { DeviceAuthorizationError, pollDeviceAuthorization } from "@/lib/api/device-authorization";
import { executeIdempotent, IdempotencyError } from "@/lib/api/idempotency";
import { enforceRateLimit, sourceIpKey } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route";
import { credentialDerivationContext, deriveBearerToken, digestDeviceCode, CLI_SESSION_PREFIX } from "@/lib/api/tokens";

const POLL_LIMIT = { routeKey: "cli-device-poll", limit: 60, windowSeconds: 60 };

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  let deviceCode: string;
  try {
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "deviceCode") || typeof (body as { deviceCode?: unknown }).deviceCode !== "string" || !(body as { deviceCode: string }).deviceCode.trim()) {
      return apiError(requestId, 400, "INVALID_DEVICE_REQUEST", "A device code is required");
    }
    deviceCode = (body as { deviceCode: string }).deviceCode.trim();
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(requestId, 400, "INVALID_JSON", "Request body must be valid JSON");
    return apiError(requestId, 400, "INVALID_DEVICE_REQUEST", "A device code is required");
  }
  // Enforce the stable source-IP limit first and short-circuit before deriving any
  // device-scoped bucket, so a stream of unique device codes cannot inflate rate-limit
  // cardinality against unknown codes.
  const ipRate = await enforceRateLimit(sourceIpKey(request), POLL_LIMIT);
  if (!ipRate.allowed) {
    const response = apiError(requestId, 429, "RATE_LIMITED", "Too many requests");
    response.headers.set("Retry-After", String(ipRate.retryAfterSeconds));
    return response;
  }
  // Reject malformed device codes before hashing or bucketing them. A well-formed code
  // is base64url of high-entropy bytes; anything else maps to one bounded rejection and
  // never creates a device bucket.
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(deviceCode)) {
    return apiError(requestId, 400, "INVALID_DEVICE_REQUEST", "A device code is required");
  }
  const deviceKey = `device:${digestDeviceCode(deviceCode).toString("hex")}`;
  const deviceRate = await enforceRateLimit(deviceKey, POLL_LIMIT);
  if (!deviceRate.allowed) {
    const response = apiError(requestId, 429, "RATE_LIMITED", "Too many requests");
    response.headers.set("Retry-After", String(deviceRate.retryAfterSeconds));
    return response;
  }
  try {
    const idempotencyKey = requiredIdempotencyKey(request);
    const result = await executeIdempotent<PollResponse>({
      request,
      principalKey: deviceKey,
      routeKey: "cli-device-poll",
      body: { deviceCode },
      work: async ({ operationId, transaction }) => transaction<PollResponse>(async (tx) => {
        const credential = deriveBearerToken(credentialDerivationContext({
          kind: "cli-session",
          principalKey: deviceKey,
          idempotencyKey,
          body: { deviceCode },
          operationId,
        }), CLI_SESSION_PREFIX);
        try {
          const session = await pollDeviceAuthorization(deviceCode, new Date(), credential, tx);
          return {
            status: 200,
            body: {
              outcome: "session" as const,
              token: session.token,
              tokenType: session.tokenType,
              expiresAt: session.expiresAt.toISOString(),
              scopes: session.scopes,
            },
          };
        } catch (error) {
          if (error instanceof DeviceAuthorizationError) {
            return { status: 400, body: { outcome: "error" as const, code: error.code, message: error.message } };
          }
          throw error;
        }
      }),
      persistBody: (body) => body.outcome === "session"
        ? {
            outcome: body.outcome,
            tokenType: body.tokenType,
            expiresAt: body.expiresAt,
            scopes: body.scopes,
          }
        : body,
      replayBody: (stored, { operationId }) => {
        const body = stored as PollResponse;
        return body.outcome === "session" ? {
          ...body,
          token: deriveBearerToken(credentialDerivationContext({
            kind: "cli-session",
            principalKey: deviceKey,
            idempotencyKey,
            body: { deviceCode },
            operationId,
          }), CLI_SESSION_PREFIX).raw,
        } : body;
      },
    });
    if (result.body.outcome === "error") {
      return apiError(requestId, result.status, result.body.code, result.body.message);
    }
    return apiJson(objectEnvelope("CliSession", {
      token: result.body.token,
      tokenType: result.body.tokenType,
      expiresAt: result.body.expiresAt,
      scopes: result.body.scopes,
    }, requestId), { status: result.status });
  } catch (error) {
    return routeError(error, requestId);
  }
}

type PollResponse =
  | { outcome: "session"; token: string; tokenType: "Bearer"; expiresAt: string; scopes: readonly string[] }
  | { outcome: "error"; code: DeviceAuthorizationError["code"]; message: string };

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED", "A UUID Idempotency-Key is required");
  }
  return key;
}
