import type { Dispatcher } from "undici"

const CHECK_ERROR_CODES = [
  "TIMEOUT",
  "DNS_ERROR",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "TLS_ERROR",
  "TOO_MANY_REDIRECTS",
  "INVALID_REDIRECT",
  "INVALID_STATUS",
  "BLOCKED_TARGET",
  "INVALID_URL",
  "RESPONSE_ERROR",
  "UNKNOWN",
] as const

export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number]
type CheckMethod = "GET" | "HEAD"
export type CheckMode = "scheduled" | "manual"

export interface CheckTarget {
  url: string
  method: CheckMethod
  timeoutMs: number
  expectedStatus: { minimum: number; maximum: number }
}

interface CheckMetadata {
  mode: CheckMode
  method: CheckMethod
  requestedUrl: string
  finalUrl: string
  hostname: string
  resolvedAddress: string | null
  statusCode: number | null
  latencyMs: number
  redirectCount: number
}

export type CheckResult =
  | (CheckMetadata & { success: true; errorCode: null; errorMessage: null })
  | (CheckMetadata & {
      success: false
      errorCode: CheckErrorCode
      errorMessage: string
    })

interface ResponseBody {
  destroy: (error?: Error) => void
}
export interface CheckerResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: ResponseBody
}

export type RequestExecutor = (
  url: URL,
  options: {
    method: CheckMethod
    dispatcher: Dispatcher
    signal: AbortSignal
    headersTimeout: number
    bodyTimeout: number
    maxRedirections: 0
    headers: Record<string, string>
  }
) => Promise<CheckerResponse>

export type ManagedDispatcher = Dispatcher & {
  close: () => Promise<void>
}
