import "server-only";

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { after } from "next/server";

import { getCurrentSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { apiTokens, cliInstallations, cliSessions } from "@/lib/db/schema";

import { ADMINISTRATOR_SCOPES, normalizeScopes, type ApiScope } from "./scopes";
import { digestBearerToken, parseBearerAuthorization } from "./tokens";

export type HumanPrincipal = {
  type: "human";
  id: string;
  email: string;
  scopes: ApiScope[];
};

export type ApiTokenPrincipal = {
  type: "api_token";
  id: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: Date;
};

export type CliSessionPrincipal = {
  type: "cli_session";
  id: string;
  email: string;
  scopes: ApiScope[];
  expiresAt: Date;
  installation: {
    id: string;
    displayName: string;
    platform: string;
    architecture: string;
    clientVersion: string;
    linkedAt: Date;
  };
};

export type Principal = HumanPrincipal | ApiTokenPrincipal | CliSessionPrincipal;

export interface PrincipalStore {
  findApiToken(digest: Buffer, now: Date): Promise<ApiTokenPrincipal | null>;
  findCliSession(digest: Buffer, now: Date): Promise<CliSessionPrincipal | null>;
  touchApiToken(id: string, now: Date): Promise<void>;
  touchCliSession(id: string, installationId: string, now: Date): Promise<void>;
}

type HumanSession = Awaited<ReturnType<typeof getCurrentSession>>;

export async function resolvePrincipal(
  request: Request,
  dependencies: {
    store?: PrincipalStore;
    getHumanSession?: () => Promise<HumanSession>;
    now?: () => Date;
  } = {},
): Promise<Principal | null> {
  const raw = parseBearerAuthorization(request.headers.get("authorization"));
  if (!raw) {
    if (request.headers.has("authorization")) return null;
    const session = await (dependencies.getHumanSession ?? getCurrentSession)();
    return session
      ? {
          type: "human",
          id: session.userId,
          email: session.email,
          scopes: [...ADMINISTRATOR_SCOPES],
        }
      : null;
  }

  const store = dependencies.store ?? databasePrincipalStore;
  const now = dependencies.now?.() ?? new Date();
  const digest = digestBearerToken(raw);
  const apiToken = await store.findApiToken(digest, now);
  if (apiToken) {
    await deferTouch(() => store.touchApiToken(apiToken.id, now));
    return apiToken;
  }
  const cliSession = await store.findCliSession(digest, now);
  if (cliSession) {
    await deferTouch(() =>
      store.touchCliSession(cliSession.id, cliSession.installation.id, now),
    );
    return cliSession;
  }
  return null;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

export const databasePrincipalStore: PrincipalStore = {
  async findApiToken(digest, now) {
    const [row] = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scopes: apiTokens.scopes,
        expiresAt: apiTokens.expiresAt,
      })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenDigest, digest),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now),
        ),
      )
      .limit(1);
    return row
      ? { type: "api_token", ...row, scopes: normalizeScopes(row.scopes) }
      : null;
  },

  async findCliSession(digest, now) {
    const [row] = await db
      .select({
        id: cliSessions.id,
        email: cliSessions.userEmail,
        scopes: cliSessions.scopes,
        expiresAt: cliSessions.expiresAt,
        installationId: cliInstallations.id,
        displayName: cliInstallations.displayName,
        platform: cliInstallations.platform,
        architecture: cliInstallations.architecture,
        clientVersion: cliInstallations.clientVersion,
        linkedAt: cliInstallations.linkedAt,
      })
      .from(cliSessions)
      .innerJoin(
        cliInstallations,
        eq(cliInstallations.id, cliSessions.installationId),
      )
      .where(
        and(
          eq(cliSessions.tokenDigest, digest),
          isNull(cliSessions.revokedAt),
          gt(cliSessions.expiresAt, now),
          isNull(cliInstallations.revokedAt),
        ),
      )
      .limit(1);
    return row
      ? {
          type: "cli_session",
          id: row.id,
          email: row.email,
          scopes: normalizeScopes(row.scopes),
          expiresAt: row.expiresAt,
          installation: {
            id: row.installationId,
            displayName: row.displayName,
            platform: row.platform,
            architecture: row.architecture,
            clientVersion: row.clientVersion,
            linkedAt: row.linkedAt,
          },
        }
      : null;
  },

  async touchApiToken(id, now) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiTokens.id, id),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, now),
          or(
            isNull(apiTokens.lastUsedAt),
            lt(apiTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS)),
          ),
        ),
      );
  },

  async touchCliSession(id, installationId, now) {
    const staleBefore = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS);
    await Promise.all([
      db
        .update(cliSessions)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(cliSessions.id, id),
            isNull(cliSessions.revokedAt),
            gt(cliSessions.expiresAt, now),
            or(isNull(cliSessions.lastUsedAt), lt(cliSessions.lastUsedAt, staleBefore)),
          ),
        ),
      db
        .update(cliInstallations)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(cliInstallations.id, installationId),
            isNull(cliInstallations.revokedAt),
            or(
              isNull(cliInstallations.lastSeenAt),
              lt(cliInstallations.lastSeenAt, staleBefore),
            ),
          ),
        ),
    ]);
  },
};

// Touches are best-effort and run outside the response path.
function deferTouch(touch: () => Promise<void>): Promise<void> {
  try {
    after(() => safeTouch(touch));
    return Promise.resolve();
  } catch {
    // after() requires a request scope. Direct callers update inline.
    return safeTouch(touch);
  }
}

async function safeTouch(touch: () => Promise<void>) {
  await touch().catch(() => undefined);
}
