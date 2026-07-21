import type { Metadata } from "next"
import { notFound } from "next/navigation"

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
    title: { absolute: config.name },
    robots: { index: true, follow: true },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  }
}

type GroupPageProps = {
  params: Promise<{ group: string }>
}

export default async function PublicGroupStatusPage({
  params,
}: GroupPageProps) {
  const { group } = await params
  const data = await getPublicStatus(group)

  if (!data) {
    notFound()
  }

  return <StatusPageContent data={data} groupView />
}
