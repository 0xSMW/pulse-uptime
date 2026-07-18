"use server";

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getPendingDeviceAuthorization,
} from "@/lib/api/device-authorization";
import { getCurrentSession } from "@/lib/auth/session";
import { parseUserCodeInput } from "@/lib/cli-authorization/user-code";

export type AuthorizationRequestView = {
  userCode: string;
  clientName: string;
  installationName: string;
  clientVersion: string;
  platform: string;
  architecture: string;
  expiresAt: string;
};

export type AuthorizationActionResult =
  | { ok: true; request: AuthorizationRequestView }
  | { ok: true; state: "approved" | "denied" }
  | { ok: false; message: string; signedOut?: boolean };

function presentRequest(request: Awaited<ReturnType<typeof getPendingDeviceAuthorization>>): AuthorizationRequestView | null {
  if (!request) return null;
  return {
    userCode: request.userCode,
    clientName: request.clientName,
    installationName: request.installationName,
    clientVersion: request.clientVersion,
    platform: request.platform,
    architecture: request.architecture,
    expiresAt: request.expiresAt.toISOString(),
  };
}

export async function lookupAuthorization(value: string): Promise<AuthorizationActionResult> {
  const parsed = parseUserCodeInput(value);
  if (!parsed.ok) return parsed;

  const session = await getCurrentSession();
  if (!session) return { ok: false, signedOut: true, message: "Sign in to continue" };

  const request = presentRequest(await getPendingDeviceAuthorization(parsed.code));
  return request
    ? { ok: true, request }
    : { ok: false, message: "This authorization request is invalid or expired" };
}

export async function approveAuthorization(userCode: string): Promise<AuthorizationActionResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, signedOut: true, message: "Sign in to continue" };
  try {
    await approveDeviceAuthorization(userCode, { id: session.userId, email: session.email });
    return { ok: true, state: "approved" };
  } catch {
    return { ok: false, message: "This authorization request is no longer available" };
  }
}

export async function denyAuthorization(userCode: string): Promise<AuthorizationActionResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, signedOut: true, message: "Sign in to continue" };
  try {
    await denyDeviceAuthorization(userCode, { id: session.userId, email: session.email });
    return { ok: true, state: "denied" };
  } catch {
    return { ok: false, message: "This authorization request is no longer available" };
  }
}

