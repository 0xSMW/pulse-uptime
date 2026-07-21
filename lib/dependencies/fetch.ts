import "server-only"

import { Agent, type Dispatcher, request as undiciRequest } from "undici"

import { BlockedTargetError, isIpLiteral } from "@/lib/checker/ip-policy"
import {
  createSecureLookup,
  type ResolveAll,
  type SecureLookup,
  systemResolveAll,
} from "@/lib/checker/secure-lookup"

import { DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES_CEILING } from "./types"

// Dependency polling needs to read a response body, unlike the endpoint
// checker which destroys it by design. This module adds the controls the
// checker never needed: a catalog host allowlist, a hard body cap, and
// conditional-request validators, while reusing the same connect-time DNS
// pinning so a status-feed host can never resolve to a private address.
//
// Body consumption is a single staged pipeline so transport failures stay
// typed as ProviderFetchError (TIMEOUT / NETWORK_ERROR / TOO_LARGE / ...) and
// never surface as raw undici exceptions. That lets the poller skip optional
// documents on fetch failure without catching parser or programming errors.

const REQUEST_DEADLINE_MS = 5000
/** Refuse to open a request when less than this remains on the effective deadline. */
const SAFETY_REMAINING_MS = 25
const MAX_REDIRECTS = 3
const USER_AGENT = "Pulse-Uptime-Dependencies/1.0"
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type FetchErrorCode =
  | "BLOCKED_HOST"
  | "BLOCKED_TARGET"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_ENCODING"
  | "TOO_MANY_REDIRECTS"
  | "INVALID_REDIRECT"
  | "NETWORK_ERROR"

/** Stage of the single response-consumption pipeline where a fetch failed. */
export type FetchErrorStage =
  | "request"
  | "body"
  | "size"
  | "decode"
  | "completion"

export interface ProviderFetchErrorMeta {
  sourceId?: string | null
  documentKind?: string | null
  url?: string | null
  stage?: FetchErrorStage | null
  cause?: unknown
}

export class ProviderFetchError extends Error {
  readonly sourceId: string | null
  readonly documentKind: string | null
  readonly url: string | null
  readonly stage: FetchErrorStage | null

  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly statusCode: number | null = null,
    readonly retryAfterMs: number | null = null,
    meta: ProviderFetchErrorMeta = {}
  ) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause })
    this.name = "ProviderFetchError"
    this.sourceId = meta.sourceId ?? null
    this.documentKind = meta.documentKind ?? null
    this.url = meta.url ?? null
    this.stage = meta.stage ?? null
  }
}

export interface FetchValidators {
  etag: string | null
  lastModified: string | null
}

export type FetchDocumentResult =
  | {
      status: "ok"
      statusCode: number
      json?: unknown
      text?: string
      etag: string | null
      lastModified: string | null
    }
  | { status: "not_modified"; etag: string | null; lastModified: string | null }

export interface FetchProviderSource {
  id: string
  allowedHosts: readonly string[]
  /**
   * Per-source body cap in bytes, raising the 512 KB default up to the 4 MB
   * ceiling. Values are clamped into [DEFAULT_MAX_BODY_BYTES,
   * MAX_BODY_BYTES_CEILING] here so a bad stored value can never disable the
   * cap. Streaming enforcement is unchanged: the stream still aborts the
   * moment the cap is crossed rather than buffering the whole body first.
   */
  maxBodyBytes?: number
}

export interface FetchProviderRequest {
  url: string
  validators?: FetchValidators
  /**
   * "json" (default) parses the capped body as JSON and returns it as `json`.
   * "text" returns the decoded body as `text` with no JSON.parse, for feeds
   * that are not JSON (RSS/Atom, SSR HTML with an embedded payload). Both
   * modes apply the identical allowlist, https-only, DNS-pinning, redirect,
   * deadline, and body-cap controls before anything is returned.
   */
  mode?: "json" | "text"
  /**
   * Document role label for structured error metadata (for example "current",
   * "incidents", "maintenance"). Optional: fetch does not interpret it.
   */
  documentKind?: string
  /**
   * Caller budget for this fetch in milliseconds. The effective timeout is the
   * minimum of the standard provider timeout and this value (and any
   * deadlineAtMs remaining).
   */
  timeoutMs?: number
  /**
   * Absolute wall-clock deadline (Date.now epoch ms). The effective timeout is
   * the minimum of the standard provider timeout and the time remaining until
   * this deadline.
   */
  deadlineAtMs?: number
}

export type ManagedDispatcher = Dispatcher & {
  close: () => Promise<void>
}

type FetchResponseBody = AsyncIterable<Uint8Array> & {
  destroy: (error?: Error) => void
}

export interface FetchResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: FetchResponseBody
}

type FetchRequestExecutor = (
  url: URL,
  options: {
    method: "GET"
    dispatcher: ManagedDispatcher
    signal: AbortSignal
    headersTimeout: number
    bodyTimeout: number
    maxRedirections: 0
    headers: Record<string, string>
  }
) => Promise<FetchResponse>

type FetchDispatcherFactory = (options: {
  lookup: SecureLookup
  connectTimeoutMs: number
}) => ManagedDispatcher

export interface FetchProviderDocumentDeps {
  resolveAll?: ResolveAll
  request?: FetchRequestExecutor
  createDispatcher?: FetchDispatcherFactory
  // A shared dispatcher reused across a poll cycle's documents. When present it
  // is used for every hop and is closed by its owner, never here.
  dispatcher?: ManagedDispatcher
  now?: () => number
}

const defaultRequest: FetchRequestExecutor = async (url, options) =>
  undiciRequest(url, options) as Promise<FetchResponse>

const defaultCreateDispatcher: FetchDispatcherFactory = ({
  lookup,
  connectTimeoutMs,
}) =>
  // pipelining 1 keeps one connection alive per host so a poll cycle's later
  // documents reuse it instead of re-running TLS and DNS. connections 1 still
  // caps this dispatcher to a single connection per origin.
  new Agent({
    connect: { lookup, timeout: connectTimeoutMs },
    connections: 1,
    pipelining: 1,
  })

/**
 * Builds a dispatcher a caller reuses across one poll cycle's documents. It
 * carries the same connect-time secure lookup as a single-call dispatcher, so
 * every new connection it opens still rejects private addresses, while the host
 * allowlist, redirect cap, deadline, and body cap are re-checked per request in
 * fetchProviderDocument regardless. The connect timeout is the full request
 * deadline because each request also passes an AbortSignal plus header and body
 * timeouts scoped to its own remaining budget, which bound the connect phase.
 * The caller owns the returned dispatcher and must close it once the cycle ends.
 */
export function createProviderDispatcher(
  deps: Pick<FetchProviderDocumentDeps, "resolveAll" | "createDispatcher"> = {}
): ManagedDispatcher {
  const resolveAll = deps.resolveAll ?? systemResolveAll
  const createDispatcher = deps.createDispatcher ?? defaultCreateDispatcher
  return createDispatcher({
    lookup: createSecureLookup({ resolveAll }),
    connectTimeoutMs: REQUEST_DEADLINE_MS,
  })
}

function assertAllowedUrl(url: URL, source: FetchProviderSource): void {
  if (url.protocol !== "https:") {
    throw new ProviderFetchError(
      "BLOCKED_HOST",
      `${source.id}: only https is allowed, got "${url.protocol}"`,
      null,
      null,
      {
        sourceId: source.id,
        stage: "request",
        url: url.toString(),
      }
    )
  }
  if (isIpLiteral(url.hostname)) {
    throw new ProviderFetchError(
      "BLOCKED_HOST",
      `${source.id}: IP literal hosts are not allowed`,
      null,
      null,
      {
        sourceId: source.id,
        stage: "request",
        url: url.toString(),
      }
    )
  }
  if (!source.allowedHosts.includes(url.hostname)) {
    throw new ProviderFetchError(
      "BLOCKED_HOST",
      `${source.id}: host "${url.hostname}" is not in the source's allowedHosts`,
      null,
      null,
      {
        sourceId: source.id,
        stage: "request",
        url: url.toString(),
      }
    )
  }
}

function headerValue(
  headers: FetchResponse["headers"],
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Cap accepted Retry-After delays at 24h. Larger or non-finite values are invalid. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

function clampRetryAfterMs(ms: number): number | null {
  if (!(Number.isFinite(ms) && ms >= 0)) {
    return null
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

function parseRetryAfterMs(
  value: string | undefined,
  nowMs: number
): number | null {
  if (!value) {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return clampRetryAfterMs(seconds * 1000)
  }
  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) {
    return null
  }
  return clampRetryAfterMs(dateMs - nowMs)
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "")
  }
  return ""
}

function errorNameOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name?: unknown }).name ?? "")
  }
  return ""
}

function isTimeoutError(error: unknown): boolean {
  const name = errorNameOf(error)
  const code = errorCodeOf(error)
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  )
}

function isBodyTimeoutError(error: unknown): boolean {
  return (
    errorCodeOf(error) === "UND_ERR_BODY_TIMEOUT" ||
    errorNameOf(error) === "TimeoutError"
  )
}

function isSocketResetError(error: unknown): boolean {
  const code = errorCodeOf(error)
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  )
}

interface FetchErrorContext {
  sourceId: string
  documentKind: string | null
  url: string
}

function withMeta(
  context: FetchErrorContext,
  stage: FetchErrorStage,
  cause?: unknown
): ProviderFetchErrorMeta {
  return {
    sourceId: context.sourceId,
    documentKind: context.documentKind,
    url: context.url,
    stage,
    cause,
  }
}

/** Classifies request-establishment failures (DNS, connect, TLS, header timeout, redirects already handled separately). */
function classifyRequestError(
  error: unknown,
  context: FetchErrorContext
): ProviderFetchError {
  if (error instanceof ProviderFetchError) {
    return error
  }
  if (error instanceof BlockedTargetError) {
    return new ProviderFetchError(
      "BLOCKED_TARGET",
      `${context.sourceId}: ${error.message}`,
      null,
      null,
      withMeta(context, "request", error)
    )
  }
  if (isTimeoutError(error)) {
    return new ProviderFetchError(
      "TIMEOUT",
      `${context.sourceId}: request timed out`,
      null,
      null,
      withMeta(context, "request", error)
    )
  }
  return new ProviderFetchError(
    "NETWORK_ERROR",
    `${context.sourceId}: ${error instanceof Error ? error.message : String(error)}`,
    null,
    null,
    withMeta(context, "request", error)
  )
}

/**
 * Classifies body-streaming failures. Body timeouts stay TIMEOUT so the poller
 * can skip optional documents. Socket resets and aborted streams become
 * NETWORK_ERROR for the same optional-document path, without swallowing parser
 * or programming errors (those are not thrown from the async iterator).
 */
function classifyBodyError(
  error: unknown,
  context: FetchErrorContext
): ProviderFetchError {
  if (error instanceof ProviderFetchError) {
    return error
  }
  // UND_ERR_BODY_TIMEOUT (and TimeoutError) are the only body-read timeouts.
  // AbortError is treated as an interrupted stream below, not a deadline miss,
  // because the caller's AbortSignal.timeout already surfaces at request stage.
  if (
    isBodyTimeoutError(error) ||
    errorCodeOf(error) === "UND_ERR_HEADERS_TIMEOUT" ||
    errorCodeOf(error) === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new ProviderFetchError(
      "TIMEOUT",
      `${context.sourceId}: response body timed out`,
      null,
      null,
      withMeta(context, "body", error)
    )
  }
  if (
    isSocketResetError(error) ||
    errorNameOf(error) === "AbortError" ||
    errorCodeOf(error) === "ABORT_ERR"
  ) {
    return new ProviderFetchError(
      "NETWORK_ERROR",
      `${context.sourceId}: response body interrupted`,
      null,
      null,
      withMeta(context, "body", error)
    )
  }
  return new ProviderFetchError(
    "NETWORK_ERROR",
    `${context.sourceId}: ${error instanceof Error ? error.message : String(error)}`,
    null,
    null,
    withMeta(context, "body", error)
  )
}

function destroyBody(
  body: { destroy?: (error?: Error) => void },
  error?: Error
): void {
  try {
    body.destroy?.(error)
  } catch {
    // Destroy is best-effort. The original failure is what the caller needs.
  }
}

/** Clamps a source's configured cap into [default, ceiling], so a missing, malformed, or over-large value can never widen past 4 MB or shrink below the 512 KB default. */
function resolveMaxBodyBytes(source: FetchProviderSource): number {
  const configured = source.maxBodyBytes
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_MAX_BODY_BYTES
  }
  return Math.min(
    MAX_BODY_BYTES_CEILING,
    Math.max(DEFAULT_MAX_BODY_BYTES, Math.floor(configured))
  )
}

/**
 * Absolute wall-clock deadline for this fetch. Effective timeout is the
 * minimum of the standard provider timeout and any remaining caller budget
 * (timeoutMs from start, or deadlineAtMs absolute).
 */
function resolveDeadlineAtMs(
  req: FetchProviderRequest,
  startedAt: number
): number {
  let deadline = startedAt + REQUEST_DEADLINE_MS
  if (typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs)) {
    deadline = Math.min(deadline, startedAt + Math.max(0, req.timeoutMs))
  }
  if (
    typeof req.deadlineAtMs === "number" &&
    Number.isFinite(req.deadlineAtMs)
  ) {
    deadline = Math.min(deadline, req.deadlineAtMs)
  }
  return deadline
}

/**
 * Reads the response body into a Buffer. Stages: body streaming (async iterator
 * errors), then size enforcement (TOO_LARGE with stream destroy). Returns only
 * a fully consumed body.
 */
async function readBounded(
  body: FetchResponseBody,
  context: FetchErrorContext,
  maxBodyBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of body) {
      total += chunk.length
      if (total > maxBodyBytes) {
        // Stage: size enforcement. Destroy the stream so the socket does not
        // keep filling memory after we refuse the rest of the payload.
        destroyBody(body)
        throw new ProviderFetchError(
          "TOO_LARGE",
          `${context.sourceId}: response exceeded ${maxBodyBytes} bytes`,
          null,
          null,
          withMeta(context, "size")
        )
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (error instanceof ProviderFetchError) {
      throw error
    }
    destroyBody(body, error instanceof Error ? error : undefined)
    throw classifyBodyError(error, context)
  }
  return Buffer.concat(chunks)
}

/**
 * Decodes a response body to a string, honoring UTF-16. AWS Health serves
 * application/json;charset=utf-16, and a UTF-16 payload read as UTF-8 is
 * mojibake that fails JSON.parse. The charset is taken from a leading
 * byte-order mark first (FF FE little-endian, FE FF big-endian, EF BB BF
 * UTF-8), then from the content-type charset parameter, else UTF-8. Node
 * decodes utf16le natively, so a big-endian body is byte-swapped into
 * little-endian first. BOMs are stripped so JSON.parse sees a bare value.
 */
function decodeBody(
  buffer: Buffer,
  contentType: string | undefined,
  context: FetchErrorContext
): string {
  try {
    const charset = /charset=\s*"?([\w-]+)/i
      .exec(contentType ?? "")?.[1]
      ?.toLowerCase()
    let text: string

    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = buffer.subarray(2).toString("utf16le")
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      text = byteSwap16(buffer.subarray(2)).toString("utf16le")
    } else if (
      buffer.length >= 3 &&
      buffer[0] === 0xef &&
      buffer[1] === 0xbb &&
      buffer[2] === 0xbf
    ) {
      // UTF-8 BOM. Strip before conversion so JSON and text callers see clean content.
      text = buffer.subarray(3).toString("utf8")
    } else if (charset === "utf-16" || charset === "utf-16le") {
      text = buffer.toString("utf16le")
    } else if (charset === "utf-16be") {
      text = byteSwap16(buffer).toString("utf16le")
    } else {
      text = buffer.toString("utf8")
    }

    // Defensive strip of a leading U+FEFF that survived decoding (for example a
    // charset-labeled UTF-8 body that still carried a BOM the byte check missed).
    if (text.charCodeAt(0) === 0xfe_ff) {
      text = text.slice(1)
    }
    return text
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the ProviderFetchError meta arg
    throw new ProviderFetchError(
      "INVALID_ENCODING",
      `${context.sourceId}: response body encoding is unsupported or invalid`,
      null,
      null,
      withMeta(context, "decode", error)
    )
  }
}

/** Swaps each 16-bit unit's byte order, turning a big-endian UTF-16 buffer into the little-endian layout Node decodes. A trailing odd byte is dropped since it cannot form a code unit. */
function byteSwap16(buffer: Buffer): Buffer {
  const evenLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1]!
    swapped[index + 1] = buffer[index]!
  }
  return swapped
}

/**
 * Fetches one status-feed document with the security posture the doc
 * requires: HTTPS-only, allowlisted hosts, no IP literals, connection-time
 * private-address rejection (via createSecureLookup), manual redirect
 * handling capped at three hops with every hop re-validated, a 5s deadline
 * (further bounded by caller timeoutMs / deadlineAtMs), and a streamed body
 * cap (512KB default, raised per source up to 4MB). Sends
 * If-None-Match/If-Modified-Since from the caller's stored validators and
 * returns a not_modified marker on 304. Decodes UTF-8/UTF-16 payloads
 * (including BOMs) and, in "text" mode, returns the raw decoded body without
 * JSON.parse. Reuses a caller-supplied dispatcher across a poll cycle's
 * documents when one is given, otherwise opens and closes its own for this
 * call. Dispatcher cleanup always stays in the caller's finally when shared.
 */
export async function fetchProviderDocument(
  source: FetchProviderSource,
  req: FetchProviderRequest,
  deps: FetchProviderDocumentDeps = {}
): Promise<FetchDocumentResult> {
  const resolveAll = deps.resolveAll ?? systemResolveAll
  const doRequest = deps.request ?? defaultRequest
  const createDispatcher = deps.createDispatcher ?? defaultCreateDispatcher
  const now = deps.now ?? Date.now
  const startedAt = now()
  const deadlineAtMs = resolveDeadlineAtMs(req, startedAt)

  let currentUrl: URL
  try {
    currentUrl = new URL(req.url)
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the ProviderFetchError meta arg
    throw new ProviderFetchError(
      "BLOCKED_HOST",
      `${source.id}: invalid URL "${req.url}"`,
      null,
      null,
      {
        sourceId: source.id,
        documentKind: req.documentKind ?? null,
        url: req.url,
        stage: "request",
        cause: error,
      }
    )
  }

  const context: FetchErrorContext = {
    sourceId: source.id,
    documentKind: req.documentKind ?? null,
    url: currentUrl.toString(),
  }

  // A poll cycle passes one shared dispatcher so this source's documents reuse a
  // single keep-alive connection per host. That dispatcher is owned by the
  // caller and is never closed here. Without one, a dispatcher is created for
  // this call, reused across every redirect hop, and closed in the finally.
  // Either way its connect-time secure lookup rejects private addresses on every
  // new connection, so reuse never bypasses the SSRF guard.
  const dispatcher =
    deps.dispatcher ??
    createProviderDispatcher({ resolveAll, createDispatcher })
  const ownsDispatcher = deps.dispatcher == null
  const maxBodyBytes = resolveMaxBodyBytes(source)
  const acceptHeader = req.mode === "text" ? "*/*" : "application/json"

  let redirects = 0
  try {
    for (;;) {
      context.url = currentUrl.toString()
      assertAllowedUrl(currentUrl, source)

      // Effective remaining budget: min(standard provider timeout, caller budget).
      const remaining = deadlineAtMs - now()
      if (remaining < SAFETY_REMAINING_MS) {
        throw new ProviderFetchError(
          "TIMEOUT",
          `${source.id}: request deadline exceeded`,
          null,
          null,
          withMeta(context, "request")
        )
      }

      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: acceptHeader,
      }
      if (redirects === 0) {
        if (req.validators?.etag) {
          headers["if-none-match"] = req.validators.etag
        }
        if (req.validators?.lastModified) {
          headers["if-modified-since"] = req.validators.lastModified
        }
      }

      let response: FetchResponse
      try {
        // Stage 1: request establishment. DNS, connection, TLS, header timeout,
        // and connect failures land here and become TIMEOUT or NETWORK_ERROR.
        response = await doRequest(currentUrl, {
          method: "GET",
          dispatcher,
          headers,
          signal: AbortSignal.timeout(remaining),
          headersTimeout: remaining,
          bodyTimeout: remaining,
          maxRedirections: 0,
        })
      } catch (error) {
        throw classifyRequestError(error, context)
      }

      if (response.statusCode === 304) {
        response.body.destroy()
        return {
          status: "not_modified",
          etag:
            headerValue(response.headers, "etag") ??
            req.validators?.etag ??
            null,
          lastModified:
            headerValue(response.headers, "last-modified") ??
            req.validators?.lastModified ??
            null,
        }
      }

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        response.body.destroy()
        const location = headerValue(response.headers, "location")
        if (!location) {
          throw new ProviderFetchError(
            "INVALID_REDIRECT",
            `${source.id}: redirect response had no location`,
            null,
            null,
            withMeta(context, "request")
          )
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new ProviderFetchError(
            "TOO_MANY_REDIRECTS",
            `${source.id}: exceeded ${MAX_REDIRECTS} redirects`,
            null,
            null,
            withMeta(context, "request")
          )
        }
        let destination: URL
        try {
          destination = new URL(location, currentUrl)
        } catch (error) {
          // biome-ignore lint/style/useErrorCause: cause is threaded through the ProviderFetchError meta arg
          throw new ProviderFetchError(
            "INVALID_REDIRECT",
            `${source.id}: redirect location "${location}" is not a valid URL`,
            null,
            null,
            withMeta(context, "request", error)
          )
        }
        redirects += 1
        currentUrl = destination
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy()
        const retryAfterMs = parseRetryAfterMs(
          headerValue(response.headers, "retry-after"),
          now()
        )
        throw new ProviderFetchError(
          "HTTP_STATUS",
          `${source.id}: unexpected status ${response.statusCode}`,
          response.statusCode,
          retryAfterMs,
          withMeta(context, "request")
        )
      }

      // Stages 2-3: body streaming and size enforcement. Returns only a fully
      // consumed body. Partial buffers never escape this function.
      const bodyBuffer = await readBounded(response.body, context, maxBodyBytes)

      // Stage 4: decode with typed encoding failures.
      const bodyText = decodeBody(
        bodyBuffer,
        headerValue(response.headers, "content-type"),
        context
      )
      const etag = headerValue(response.headers, "etag") ?? null
      const lastModified =
        headerValue(response.headers, "last-modified") ?? null

      // Stage 5: completion. Only a fully consumed, decoded body is returned.
      if (req.mode === "text") {
        return {
          status: "ok",
          statusCode: response.statusCode,
          text: bodyText,
          etag,
          lastModified,
        }
      }

      try {
        return {
          status: "ok",
          statusCode: response.statusCode,
          json: JSON.parse(bodyText),
          etag,
          lastModified,
        }
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: cause is threaded through the ProviderFetchError meta arg
        throw new ProviderFetchError(
          "INVALID_JSON",
          `${source.id}: response body is not valid JSON`,
          null,
          null,
          withMeta(context, "completion", error)
        )
      }
    }
  } finally {
    if (ownsDispatcher) {
      await dispatcher.close()
    }
  }
}
