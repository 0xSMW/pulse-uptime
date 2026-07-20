import { NextResponse } from "next/server";

import { enforceRateLimit, sourceIpKey } from "@/lib/api/rate-limit";
import { getCurrentSession } from "@/lib/auth/session";
import { hasAdministrator } from "@/lib/auth/service";
import { checkOnboardingReadiness } from "@/lib/onboarding/readiness";

// Postgres-backed so the bucket holds across serverless instances.
const READINESS_LIMIT = { routeKey: "onboarding-readiness", limit: 10, windowSeconds: 60 };
let cache: { expiresAt: number; report: Awaited<ReturnType<typeof checkOnboardingReadiness>> } | null = null;

export async function GET(request: Request) {
  // The readiness probe performs privileged provider writes (Edge Config, email). Once
  // the installation is claimed, only the authenticated administrator finishing
  // onboarding may drive it — anonymous callers are switched off, which removes the
  // unauthenticated post-bootstrap side-effect path while keeping the onboarding flow
  // (which can navigate back to this step after the account is created) working.
  if (await hasAdministrator() && !(await getCurrentSession())) {
    return NextResponse.json({ error: "Onboarding is already complete" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }

  const rate = await enforceRateLimit(sourceIpKey(request), READINESS_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Try again shortly" }, { status: 429 });
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.report, { headers: { "Cache-Control": "no-store" } });
  }
  const report = await checkOnboardingReadiness();
  cache = { expiresAt: now + 30_000, report };
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
