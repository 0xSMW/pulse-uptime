import { NextResponse } from "next/server"

import {
  createLocalAdmissionControl,
  localAdmissionSourceKey,
} from "@/lib/api/local-admission"
import { enforceRateLimit, sourceIpKey } from "@/lib/api/rate-limit"
import { abortSignalForDeadline } from "@/lib/async/deadline"
import { hasAdministrator } from "@/lib/auth/service"
import { authenticateCurrentSession } from "@/lib/auth/session"
import {
  getOnboardingReadiness,
  ONBOARDING_READINESS_TIMEOUT_MS,
} from "@/lib/onboarding/readiness"

// Postgres-backed so the bucket holds across serverless instances.
const READINESS_LIMIT = {
  routeKey: "onboarding-readiness",
  limit: 10,
  windowSeconds: 60,
}

const readinessAdmission = createLocalAdmissionControl({
  limit: READINESS_LIMIT.limit,
  maxEntries: 4096,
  windowMs: READINESS_LIMIT.windowSeconds * 1000,
})

export async function GET(request: Request) {
  const admission = readinessAdmission.check(localAdmissionSourceKey(request))
  if (!admission.allowed) {
    const response = NextResponse.json(
      { error: "Try again shortly" },
      { status: 429 }
    )
    response.headers.set("Retry-After", String(admission.retryAfterSeconds))
    return response
  }

  // The readiness probe performs privileged provider writes (Edge Config, email). Once
  // the installation is claimed, only the authenticated administrator finishing
  // onboarding may drive it — anonymous callers are switched off, which removes the
  // unauthenticated post-bootstrap side-effect path while keeping the onboarding flow
  // (which can navigate back to this step after the account is created) working.
  if (await hasAdministrator()) {
    const session = await authenticateCurrentSession()
    if (!session) {
      return NextResponse.json(
        { error: "Onboarding is already complete" },
        { status: 410, headers: { "Cache-Control": "no-store" } }
      )
    }
    if (session.role !== "admin") {
      return NextResponse.json(
        { error: "Administrator access required" },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      )
    }
  }

  const rate = await enforceRateLimit(sourceIpKey(request), READINESS_LIMIT)
  if (!rate.allowed) {
    return NextResponse.json({ error: "Try again shortly" }, { status: 429 })
  }

  const nowMs = Date.now()
  const deadlineAtMs = nowMs + ONBOARDING_READINESS_TIMEOUT_MS
  // Outer deadline aborts provider HTTP. The query executor bounds all DB work.
  const deadlineSignal = abortSignalForDeadline(deadlineAtMs, nowMs)
  const signal = request.signal.aborted
    ? request.signal
    : AbortSignal.any([request.signal, deadlineSignal])

  const report = await getOnboardingReadiness({ deadlineAtMs, signal, nowMs })
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  })
}

export function resetReadinessAdmissionForTests(): void {
  readinessAdmission.reset()
}
