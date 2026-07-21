import { notFound } from "next/navigation"
import { Suspense } from "react"

import { DependencyDetail } from "@/components/dependencies/dependency-detail"
import { DependencyDetailSkeleton } from "@/components/dependencies/dependency-detail-skeleton"
import { findDependencyDetail } from "@/lib/dependencies/queries"

export default async function DependencyDetailPage({
  params,
}: {
  params: Promise<{ dependencyId: string }>
}) {
  const { dependencyId } = await params
  return (
    <Suspense fallback={<DependencyDetailSkeleton />}>
      <DependencyDetailIsland dependencyId={dependencyId} />
    </Suspense>
  )
}

async function DependencyDetailIsland({
  dependencyId,
}: {
  dependencyId: string
}) {
  const dependency = await findDependencyDetail(dependencyId)
  if (!dependency) {
    notFound()
  }
  return <DependencyDetail dependency={dependency} />
}
