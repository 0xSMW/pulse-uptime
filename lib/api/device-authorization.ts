import "server-only";

import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { apiIdempotency, cliInstallations, cliSessions, deviceAuthorizations } from "@/lib/db/schema";

import type { HumanPrincipal } from "./principal";
import { ADMINISTRATOR_SCOPES, resolveScopeProfile } from "./scopes";
import {
  CLI_SESSION_PREFIX,
  createBearerToken,
  createDeviceCode,
  digestBearerToken,
  digestDeviceCode,
  parseBearerAuthorization,
} from "./tokens";

const DEVICE_TTL_MS = 10 * 60_000;
const CLI_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const INITIAL_POLL_SECONDS = 5;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type PendingDeviceAuthorization = {
  id: string;
  userCode: string;
  clientName: string;
  installationName: string;
  platform: string;
  architecture: string;
  clientVersion: string;
  requestIp: string | null;
  expiresAt: Date;
  scopes: readonly string[];
};

export class DeviceAuthorizationError extends Error {
  constructor(
    readonly code: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "INVALID_DEVICE_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthorizationError";
  }
}

export function normalizeUserCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export async function getPendingDeviceAuthorization(
  userCode: string,
  now = new Date(),
): Promise<PendingDeviceAuthorization | null> {
  const normalized = normalizeUserCode(userCode);
  await db.update(deviceAuthorizations).set({ state: "expired" }).where(and(
    sql`lower(${deviceAuthorizations.userCode}) = lower(${normalized})`,
    inArray(deviceAuthorizations.state, ["pending", "approved"]),
    lte(deviceAuthorizations.expiresAt, now),
  ));
  const [row] = await db.select({
    id: deviceAuthorizations.id,
    userCode: deviceAuthorizations.userCode,
    clientName: deviceAuthorizations.clientName,
    installationName: deviceAuthorizations.installationName,
    platform: deviceAuthorizations.platform,
    architecture: deviceAuthorizations.architecture,
    clientVersion: deviceAuthorizations.clientVersion,
    requestIp: deviceAuthorizations.requestIp,
    expiresAt: deviceAuthorizations.expiresAt,
  }).from(deviceAuthorizations).where(and(
    sql`lower(${deviceAuthorizations.userCode}) = lower(${normalized})`,
    eq(deviceAuthorizations.state, "pending"),
    gt(deviceAuthorizations.expiresAt, now),
  )).limit(1);
  return row ? { ...row, scopes: ADMINISTRATOR_SCOPES } : null;
}

export async function approveDeviceAuthorization(
  userCode: string,
  human: Pick<HumanPrincipal, "id" | "email">,
  now = new Date(),
): Promise<PendingDeviceAuthorization | null> {
  const normalized = normalizeUserCode(userCode);
  return db.transaction(async (tx) => {
    const [authorization] = await tx.update(deviceAuthorizations).set({
      state: "approved",
      approvedByEmail: human.email,
      approvedAt: now,
    }).where(and(
      sql`lower(${deviceAuthorizations.userCode}) = lower(${normalized})`,
      eq(deviceAuthorizations.state, "pending"),
      gt(deviceAuthorizations.expiresAt, now),
    )).returning();
    if (!authorization) {
      throw new DeviceAuthorizationError("expired_token", "Authorization request is no longer available");
    }
    await tx.insert(cliInstallations).values({
      id: crypto.randomUUID(),
      installationKey: authorization.installationKey,
      userEmail: human.email,
      displayName: authorization.installationName,
      platform: authorization.platform,
      architecture: authorization.architecture,
      clientVersion: authorization.clientVersion,
      createdAt: now,
      linkedAt: now,
    }).onConflictDoUpdate({
      target: cliInstallations.installationKey,
      set: {
        userEmail: human.email,
        displayName: authorization.installationName,
        platform: authorization.platform,
        architecture: authorization.architecture,
        clientVersion: authorization.clientVersion,
        linkedAt: now,
        revokedAt: null,
      },
    });
    return {
      id: authorization.id,
      userCode: authorization.userCode,
      clientName: authorization.clientName,
      installationName: authorization.installationName,
      platform: authorization.platform,
      architecture: authorization.architecture,
      clientVersion: authorization.clientVersion,
      requestIp: authorization.requestIp,
      expiresAt: authorization.expiresAt,
      scopes: ADMINISTRATOR_SCOPES,
    };
  });
}

export async function denyDeviceAuthorization(
  userCode: string,
  _human: Pick<HumanPrincipal, "id" | "email">,
  now = new Date(),
): Promise<boolean> {
  const rows = await db.update(deviceAuthorizations).set({ state: "denied", deniedAt: now }).where(and(
    sql`lower(${deviceAuthorizations.userCode}) = lower(${normalizeUserCode(userCode)})`,
    eq(deviceAuthorizations.state, "pending"),
    gt(deviceAuthorizations.expiresAt, now),
  )).returning({ id: deviceAuthorizations.id });
  if (rows.length === 0) {
    throw new DeviceAuthorizationError("expired_token", "Authorization request is no longer available");
  }
  return true;
}

export async function startDeviceAuthorization(input: {
  clientName: string;
  installationKey: string;
  installationName: string;
  clientVersion: string;
  platform: string;
  architecture: string;
  scopeProfile: string;
  requestIp: string | null;
  deviceCredential?: ReturnType<typeof createDeviceCode>;
  userCode?: string;
}, now = new Date()) {
  if (input.clientName !== "pulsectl" || input.scopeProfile !== "administrator") {
    throw new DeviceAuthorizationError("INVALID_DEVICE_REQUEST", "Unsupported client or scope profile");
  }
  if (input.deviceCredential) {
    const [existing] = await db.select({
      userCode: deviceAuthorizations.userCode,
      pollingIntervalSeconds: deviceAuthorizations.pollingIntervalSeconds,
    }).from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeDigest, input.deviceCredential.digest)).limit(1);
    if (existing) {
      return {
        deviceCode: input.deviceCredential.raw,
        userCode: existing.userCode,
        expiresIn: 600,
        interval: existing.pollingIntervalSeconds,
      };
    }
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const deviceCode = input.deviceCredential ?? createDeviceCode();
    const userCode = input.userCode ?? generateUserCode();
    try {
      await db.insert(deviceAuthorizations).values({
        id: crypto.randomUUID(),
        deviceCodeDigest: deviceCode.digest,
        userCode,
        scopeProfile: "administrator",
        clientName: "pulsectl",
        installationKey: input.installationKey,
        installationName: input.installationName,
        platform: input.platform,
        architecture: input.architecture,
        clientVersion: input.clientVersion,
        requestIp: input.requestIp,
        state: "pending",
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_TTL_MS),
        pollingIntervalSeconds: INITIAL_POLL_SECONDS,
      });
      return { deviceCode: deviceCode.raw, userCode, expiresIn: 600, interval: INITIAL_POLL_SECONDS };
    } catch (error) {
      if ((error as { code?: string }).code !== "23505" || attempt === 5) throw error;
    }
  }
  throw new Error("Could not allocate a device authorization");
}

export async function pollDeviceAuthorization(
  rawDeviceCode: string,
  now = new Date(),
  sessionCredential?: ReturnType<typeof createBearerToken>,
) {
  const digest = digestDeviceCode(rawDeviceCode);
  const outcome = await db.transaction(async (tx) => {
    if (sessionCredential) {
      const [existingSession] = await tx.select({
        expiresAt: cliSessions.expiresAt,
        scopes: cliSessions.scopes,
        scopeProfile: cliSessions.scopeProfile,
      }).from(cliSessions).where(eq(cliSessions.tokenDigest, sessionCredential.digest)).limit(1);
      if (existingSession) {
        return { session: {
          token: sessionCredential.raw,
          tokenType: "Bearer" as const,
          expiresAt: existingSession.expiresAt,
          scopes: resolveScopeProfile(existingSession.scopeProfile) ?? existingSession.scopes,
        } };
      }
    }
    const [authorization] = await tx.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeDigest, digest)).for("update").limit(1);
    if (!authorization) return { error: new DeviceAuthorizationError("expired_token", "Device code is invalid or expired") };
    if (authorization.expiresAt <= now || authorization.state === "consumed" || authorization.state === "expired") {
      await tx.update(deviceAuthorizations).set({ state: "expired" }).where(eq(deviceAuthorizations.id, authorization.id));
      return { error: new DeviceAuthorizationError("expired_token", "Device code is invalid or expired") };
    }
    if (authorization.state === "denied") return { error: new DeviceAuthorizationError("access_denied", "Authorization was denied") };
    if (authorization.state === "pending") {
      const tooSoon = authorization.lastPolledAt &&
        now.getTime() - authorization.lastPolledAt.getTime() < authorization.pollingIntervalSeconds * 1_000;
      await tx.update(deviceAuthorizations).set({
        lastPolledAt: now,
        pollCount: authorization.pollCount + 1,
        pollingIntervalSeconds: tooSoon ? authorization.pollingIntervalSeconds + 5 : authorization.pollingIntervalSeconds,
      }).where(eq(deviceAuthorizations.id, authorization.id));
      return { error: new DeviceAuthorizationError(tooSoon ? "slow_down" : "authorization_pending", tooSoon ? "Polling too quickly" : "Authorization is pending") };
    }

    const [installation] = await tx.select().from(cliInstallations)
      .where(and(eq(cliInstallations.installationKey, authorization.installationKey), isNull(cliInstallations.revokedAt)))
      .limit(1);
    if (!installation) return { error: new DeviceAuthorizationError("expired_token", "Installation approval is no longer valid") };
    const claimed = await tx.update(deviceAuthorizations).set({ state: "consumed", consumedAt: now })
      .where(and(eq(deviceAuthorizations.id, authorization.id), eq(deviceAuthorizations.state, "approved")))
      .returning({ id: deviceAuthorizations.id });
    if (!claimed[0]) return { error: new DeviceAuthorizationError("expired_token", "Device code was already consumed") };
    const token = sessionCredential ?? createBearerToken(CLI_SESSION_PREFIX);
    const expiresAt = new Date(now.getTime() + CLI_SESSION_TTL_MS);
    await tx.insert(cliSessions).values({
      id: crypto.randomUUID(),
      installationId: installation.id,
      tokenPrefix: token.prefix,
      tokenDigest: token.digest,
      userEmail: installation.userEmail,
      scopes: [...ADMINISTRATOR_SCOPES],
      scopeProfile: "administrator",
      createdAt: now,
      expiresAt,
    });
    return { session: { token: token.raw, tokenType: "Bearer" as const, expiresAt, scopes: ADMINISTRATOR_SCOPES } };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.session;
}

export async function revokeCliInstallation(principal: { type: string; id: string }, now = new Date()) {
  if (principal.type !== "cli_session") return false;
  return db.transaction(async (tx) => {
    const [session] = await tx.select({ installationId: cliSessions.installationId }).from(cliSessions)
      .where(eq(cliSessions.id, principal.id)).limit(1);
    if (!session) return false;
    await tx.update(cliInstallations).set({ revokedAt: now }).where(eq(cliInstallations.id, session.installationId));
    await tx.update(cliSessions).set({ revokedAt: now }).where(and(
      eq(cliSessions.installationId, session.installationId),
      isNull(cliSessions.revokedAt),
    ));
    return true;
  });
}

export async function resolveRevokedCliRevokeReplay(request: Request): Promise<{ id: string; principalKey: string } | null> {
  const raw = parseBearerAuthorization(request.headers.get("authorization"));
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!raw || !idempotencyKey) return null;
  const [session] = await db.select({ id: cliSessions.id }).from(cliSessions)
    .where(eq(cliSessions.tokenDigest, digestBearerToken(raw))).limit(1);
  if (!session) return null;
  const principalKey = `cli_session:${session.id}`;
  const [record] = await db.select({ id: apiIdempotency.id }).from(apiIdempotency).where(and(
    eq(apiIdempotency.principalKey, principalKey),
    eq(apiIdempotency.idempotencyKey, idempotencyKey),
    eq(apiIdempotency.routeKey, "cli-session-revoke"),
  )).limit(1);
  return record ? { id: session.id, principalKey } : null;
}

export async function isCliInstallationRevoked(sessionId: string): Promise<boolean> {
  const [row] = await db.select({ revokedAt: cliInstallations.revokedAt }).from(cliSessions)
    .innerJoin(cliInstallations, eq(cliInstallations.id, cliSessions.installationId))
    .where(eq(cliSessions.id, sessionId)).limit(1);
  return row?.revokedAt !== null && row?.revokedAt !== undefined;
}

function generateUserCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const value = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}
