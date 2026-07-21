import { BlockedTargetError } from "./ip-policy"
import type { CheckErrorCode } from "./types"
import { MonitorValidationError } from "./validation"

const DNS_CODES = new Set(["EAI_AGAIN", "EAI_FAIL", "ENODATA", "ENOTFOUND"])
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])
const TIMEOUT_CODES = new Set([
  "ABORT_ERR",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined
  }
  return chain
}

export function classifyCheckError(error: unknown): CheckErrorCode {
  for (const item of errorChain(error)) {
    if (item instanceof BlockedTargetError) {
      return "BLOCKED_TARGET"
    }
    if (item instanceof MonitorValidationError) {
      return "INVALID_URL"
    }
    if (item instanceof DOMException && item.name === "AbortError") {
      return "TIMEOUT"
    }
    const code =
      typeof item === "object" && item !== null && "code" in item
        ? String((item as { code?: unknown }).code)
        : ""
    if (TIMEOUT_CODES.has(code)) {
      return "TIMEOUT"
    }
    if (DNS_CODES.has(code)) {
      return "DNS_ERROR"
    }
    if (code === "ECONNREFUSED") {
      return "CONNECTION_REFUSED"
    }
    if (code === "ECONNRESET" || code === "EPIPE") {
      return "CONNECTION_RESET"
    }
    if (
      TLS_CODES.has(code) ||
      code.startsWith("ERR_SSL_") ||
      code.startsWith("ERR_TLS_")
    ) {
      return "TLS_ERROR"
    }
    if (code.startsWith("UND_ERR_")) {
      return "RESPONSE_ERROR"
    }
  }
  return "UNKNOWN"
}

export const ERROR_MESSAGES: Record<CheckErrorCode, string> = {
  TIMEOUT: "Request timed out",
  DNS_ERROR: "DNS resolution failed",
  CONNECTION_REFUSED: "Connection was refused",
  CONNECTION_RESET: "Connection was reset",
  TLS_ERROR: "TLS connection failed",
  TOO_MANY_REDIRECTS: "Too many redirects",
  INVALID_REDIRECT: "Redirect destination is invalid",
  INVALID_STATUS: "Response status was outside the expected range",
  BLOCKED_TARGET: "Target is not publicly routable",
  INVALID_URL: "Target URL is invalid",
  RESPONSE_ERROR: "Response could not be read",
  UNKNOWN: "Check failed",
}
