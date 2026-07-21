"use server"

import {
  listStatusReportUpdates,
  requireStatusReport,
  StatusReportError,
} from "@/lib/api/status-reports"
import { renderRestrictedMarkdown } from "@/lib/markdown/restricted"

/**
 * Public older-page loader for a published report timeline. Shares the same
 * listStatusReportUpdates service (and cursor contract) as
 * GET /api/v1/status-reports/{reportId}/updates. Drafts and unknown ids fail
 * closed so the public page never leaks private history. Update bodies are
 * rendered to sanitized HTML here so the restricted renderer stays server only.
 */
export async function loadPublicReportUpdates(
  reportId: string,
  cursor: string
): Promise<{
  data: Array<{
    id: string
    status:
      | "investigating"
      | "identified"
      | "monitoring"
      | "resolved"
      | "scheduled"
      | "in_progress"
      | "completed"
    html: string
    publishedAt: string
    createdAt: string
  }>
  nextCursor: string | null
}> {
  try {
    const report = await requireStatusReport(reportId)
    if (!report.publishedAt) {
      throw new StatusReportError(
        "REPORT_NOT_FOUND",
        "Status report was not found"
      )
    }
    const page = await listStatusReportUpdates(reportId, { cursor, limit: 50 })
    return {
      data: page.data.map((update) => ({
        id: update.id,
        status: update.status,
        html: renderRestrictedMarkdown(update.markdown),
        publishedAt: update.publishedAt,
        createdAt: update.createdAt,
      })),
      nextCursor: page.nextCursor,
    }
  } catch (error) {
    if (error instanceof StatusReportError) {
      throw new Error(error.message, { cause: error })
    }
    throw error
  }
}
