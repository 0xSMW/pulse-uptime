import { NextResponse } from "next/server";

import { checkOnboardingReadiness } from "@/lib/onboarding/readiness";

const limits = new Map<string, { count: number; resetAt: number }>();
let cache: { expiresAt: number; report: Awaited<ReturnType<typeof checkOnboardingReadiness>> } | null = null;

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const current = limits.get(ip);
  if (current && current.resetAt > now && current.count >= 10) {
    return NextResponse.json({ error: "Try again shortly" }, { status: 429 });
  }
  limits.set(ip, current && current.resetAt > now
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: now + 60_000 });

  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.report, { headers: { "Cache-Control": "no-store" } });
  }
  const report = await checkOnboardingReadiness();
  cache = { expiresAt: now + 30_000, report };
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
