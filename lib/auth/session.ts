import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { digestSessionToken, SESSION_COOKIE_NAME } from "./credentials";
import { findSessionByDigest, type HumanSession } from "./service";

// cache(): layouts and data islands within one request share a single lookup.
export const getCurrentSession = cache(async (): Promise<HumanSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return token ? findSessionByDigest(digestSessionToken(token)) : null;
});

export function sessionCookie(token: string, expires: Date) {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    expires,
  };
}

export function expiredSessionCookie() {
  return sessionCookie("", new Date(0));
}
