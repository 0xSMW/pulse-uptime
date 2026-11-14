import { SettingsApiError } from "@/components/settings/settings-api"

/** messageForError-style mapping for the status-reports route family. */
export function messageForReportError(error: unknown): string {
  if (error instanceof SettingsApiError) {
    if (error.code === "LAST_UPDATE") {
      return "Keep at least one update or delete the report"
    }
    if (error.code === "ALREADY_PUBLISHED") {
      return "This report is already published."
    }
    if (error.code === "REPORT_NOT_FOUND") {
      return "This report no longer exists."
    }
    return error.message
  }
  return error instanceof Error ? error.message : "Something went wrong"
}
