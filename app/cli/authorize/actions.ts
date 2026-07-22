"use server"

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  expireStaleDeviceAuthorizations,
  findPendingDeviceAuthorization,
} from "@/lib/api/device-authorization"
import { authenticateCurrentSession } from "@/lib/auth/session"
import { parseUserCodeInput } from "@/lib/cli-authorization/user-code"

export interface AuthorizationRequestView {
  userCode: string
  clientName: string
  installationName: string
  clientVersion: string
  platform: string
  architecture: string
  requestIp: string | null
  expiresAt: string
}

export type AuthorizationActionResult =
  | { ok: true; request: AuthorizationRequestView }
  | { ok: true; state: "approved" | "denied" }
  | { ok: false; message: string; signedOut?: boolean }

// CLI sessions are minted with the administrator scope profile, so a viewer
// approving one would escalate their own access.
const ADMIN_ONLY_MESSAGE = "Only admins can authorize CLI access"

function presentRequest(
  request: Awaited<ReturnType<typeof findPendingDeviceAuthorization>>
): AuthorizationRequestView | null {
  if (!request) {
    return null
  }
  return {
    userCode: request.userCode,
    clientName: request.clientName,
    installationName: request.installationName,
    clientVersion: request.clientVersion,
    platform: request.platform,
    architecture: request.architecture,
    requestIp: request.requestIp,
    expiresAt: request.expiresAt.toISOString(),
  }
}

export async function lookupAuthorization(
  value: string
): Promise<AuthorizationActionResult> {
  const parsed = parseUserCodeInput(value)
  if (!parsed.ok) {
    return parsed
  }

  const session = await authenticateCurrentSession()
  if (!session) {
    return { ok: false, signedOut: true, message: "Sign in to continue" }
  }
  if (session.role !== "admin") {
    return { ok: false, message: ADMIN_ONLY_MESSAGE }
  }

  const now = new Date()
  await expireStaleDeviceAuthorizations(parsed.code, now)
  const request = presentRequest(
    await findPendingDeviceAuthorization(parsed.code, now)
  )
  return request
    ? { ok: true, request }
    : { ok: false, message: "This authorization request is invalid or expired" }
}

export async function approveAuthorization(
  userCode: string
): Promise<AuthorizationActionResult> {
  const session = await authenticateCurrentSession()
  if (!session) {
    return { ok: false, signedOut: true, message: "Sign in to continue" }
  }
  if (session.role !== "admin") {
    return { ok: false, message: ADMIN_ONLY_MESSAGE }
  }
  try {
    await approveDeviceAuthorization(userCode, {
      id: session.userId,
      email: session.email,
    })
    return { ok: true, state: "approved" }
  } catch {
    return {
      ok: false,
      message: "This authorization request is no longer available",
    }
  }
}

export async function denyAuthorization(
  userCode: string
): Promise<AuthorizationActionResult> {
  const session = await authenticateCurrentSession()
  if (!session) {
    return { ok: false, signedOut: true, message: "Sign in to continue" }
  }
  if (session.role !== "admin") {
    return { ok: false, message: ADMIN_ONLY_MESSAGE }
  }
  try {
    await denyDeviceAuthorization(userCode, {
      id: session.userId,
      email: session.email,
    })
    return { ok: true, state: "denied" }
  } catch {
    return {
      ok: false,
      message: "This authorization request is no longer available",
    }
  }
}
