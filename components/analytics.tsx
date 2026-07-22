"use client"

import { Analytics } from "@vercel/analytics/next"

import { filterAnalyticsEvent } from "@/lib/analytics"

export function VercelAnalytics() {
  return <Analytics beforeSend={filterAnalyticsEvent} />
}
