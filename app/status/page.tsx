import type { Metadata } from "next"

import { StatusPageContent } from "@/components/status-page/status-page-content"
import {
  getPublicStatus,
  getStatusFaviconDataUri,
  getStatusPageDisplayConfig,
} from "@/lib/reporting/queries/status"

export const revalidate = 30

export async function generateMetadata(): Promise<Metadata> {
  const [config, favicon] = await Promise.all([
    getStatusPageDisplayConfig(),
    getStatusFaviconDataUri(),
  ])
  return {
    // Absolute: a personalized status page should not carry the app template.
    title: { absolute: config.name },
    robots: { index: true, follow: true },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  }
}

export default async function PublicStatusPage() {
  // DB outages surface through StatusPageContent's degraded shell.
  const data = await getPublicStatus()

  return <StatusPageContent data={data} />
}
