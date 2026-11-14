import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
  SettingsApiError,
} from "@/components/settings/settings-api"

export interface MonitorTestResult {
  successful?: boolean
  statusCode?: number | null
  errorCode?: string | null
  errorMessage?: string | null
}

export interface MonitorTestOutcome {
  status: "success" | "error"
  message: string
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

// A probe can fail after an HTTP 200, for example on a content mismatch or a
// body read timeout. Only INVALID_STATUS means the status itself failed.
function failureDetail(result: MonitorTestResult | null | undefined): string {
  const errorCode = text(result?.errorCode)
  const statusCode = result?.statusCode
  if (errorCode === "INVALID_STATUS" && Number.isInteger(statusCode)) {
    return `HTTP ${statusCode}`
  }
  return text(result?.errorMessage) ?? errorCode ?? "Unknown failure"
}

// A completed probe can still fail. The endpoint reports that in the
// successful flag, so only an explicit success reads as a pass.
export function monitorTestOutcome(
  result: MonitorTestResult | null | undefined
): MonitorTestOutcome {
  if (result?.successful === true) {
    return { status: "success", message: "Monitor check passed" }
  }
  return {
    status: "error",
    message: `Monitor check failed with ${failureDetail(result)}`,
  }
}

export async function runMonitorTest(
  monitorId: string
): Promise<MonitorTestOutcome> {
  try {
    const response = await apiRequest<
      ApiEnvelope<MonitorTestResult> | undefined
    >(
      `/api/v1/monitors/${encodeURIComponent(monitorId)}/test`,
      { method: "POST" },
      { mutation: true }
    )
    return monitorTestOutcome(response?.data)
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof SettingsApiError
          ? messageForError(error)
          : "Unable to reach the server. Try again.",
    }
  }
}
