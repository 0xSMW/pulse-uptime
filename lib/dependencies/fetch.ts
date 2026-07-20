import "server-only";

import { Agent, request as undiciRequest, type Dispatcher } from "undici";

import { BlockedTargetError, isIpLiteral } from "@/lib/checker/ip-policy";
import { createSecureLookup, systemResolveAll, type ResolveAll, type SecureLookup } from "@/lib/checker/secure-lookup";

import { DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES_CEILING } from "./types";

// Dependency polling needs to read a response body, unlike the endpoint
// checker which destroys it by design. This module adds the controls the
// checker never needed: a catalog host allowlist, a hard body cap, and
// conditional-request validators, while reusing the same connect-time DNS
// pinning so a status-feed host can never resolve to a private address.

const REQUEST_DEADLINE_MS = 5_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Pulse-Uptime-Dependencies/1.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchErrorCode =
  | "BLOCKED_HOST"
  | "BLOCKED_TARGET"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "TOO_MANY_REDIRECTS"
  | "INVALID_REDIRECT"
  | "NETWORK_ERROR";

export class ProviderFetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly statusCode: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderFetchError";
  }
}

export interface FetchValidators {
  etag: string | null;
  lastModified: string | null;
}

export type FetchDocumentResult =
  | { status: "ok"; statusCode: number; json?: unknown; text?: string; etag: string | null; lastModified: string | null }
  | { status: "not_modified"; etag: string | null; lastModified: string | null };

export interface FetchProviderSource {
  id: string;
  allowedHosts: readonly string[];
  /**
   * Per-source body cap in bytes, raising the 512 KB default up to the 4 MB
   * ceiling. Values are clamped into [DEFAULT_MAX_BODY_BYTES,
   * MAX_BODY_BYTES_CEILING] here so a bad stored value can never disable the
   * cap. Streaming enforcement is unchanged: the stream still aborts the
   * moment the cap is crossed rather than buffering the whole body first.
   */
  maxBodyBytes?: number;
}

export interface FetchProviderRequest {
  url: string;
  validators?: FetchValidators;
  /**
   * "json" (default) parses the capped body as JSON and returns it as `json`.
   * "text" returns the decoded body as `text` with no JSON.parse, for feeds
   * that are not JSON (RSS/Atom, SSR HTML with an embedded payload). Both
   * modes apply the identical allowlist, https-only, DNS-pinning, redirect,
   * deadline, and body-cap controls before anything is returned.
   */
  mode?: "json" | "text";
}

export type ManagedDispatcher = Dispatcher & {
  close(): Promise<void>;
};

export type FetchResponseBody = AsyncIterable<Uint8Array> & { destroy(error?: Error): void };

export type FetchResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: FetchResponseBody;
};

export type FetchRequestExecutor = (
  url: URL,
  options: {
    method: "GET";
    dispatcher: ManagedDispatcher;
    signal: AbortSignal;
    headersTimeout: number;
    bodyTimeout: number;
    maxRedirections: 0;
    headers: Record<string, string>;
  },
) => Promise<FetchResponse>;

export type FetchDispatcherFactory = (options: { lookup: SecureLookup; connectTimeoutMs: number }) => ManagedDispatcher;

export interface FetchProviderDocumentDeps {
  resolveAll?: ResolveAll;
  request?: FetchRequestExecutor;
  createDispatcher?: FetchDispatcherFactory;
  // A shared dispatcher reused across a poll cycle's documents. When present it
  // is used for every hop and is closed by its owner, never here.
  dispatcher?: ManagedDispatcher;
  now?: () => number;
}

const defaultRequest: FetchRequestExecutor = async (url, options) =>
  undiciRequest(url, options) as Promise<FetchResponse>;

const defaultCreateDispatcher: FetchDispatcherFactory = ({ lookup, connectTimeoutMs }) =>
  // pipelining 1 keeps one connection alive per host so a poll cycle's later
  // documents reuse it instead of re-running TLS and DNS. connections 1 still
  // caps this dispatcher to a single connection per origin.
  new Agent({ connect: { lookup, timeout: connectTimeoutMs }, connections: 1, pipelining: 1 });

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
  deps: Pick<FetchProviderDocumentDeps, "resolveAll" | "createDispatcher"> = {},
): ManagedDispatcher {
  const resolveAll = deps.resolveAll ?? systemResolveAll;
  const createDispatcher = deps.createDispatcher ?? defaultCreateDispatcher;
  return createDispatcher({ lookup: createSecureLookup({ resolveAll }), connectTimeoutMs: REQUEST_DEADLINE_MS });
}

function assertAllowedUrl(url: URL, source: FetchProviderSource): void {
  if (url.protocol !== "https:") {
    throw new ProviderFetchError("BLOCKED_HOST", `${source.id}: only https is allowed, got "${url.protocol}"`);
  }
  if (isIpLiteral(url.hostname)) {
    throw new ProviderFetchError("BLOCKED_HOST", `${source.id}: IP literal hosts are not allowed`);
  }
  if (!source.allowedHosts.includes(url.hostname)) {
    throw new ProviderFetchError("BLOCKED_HOST", `${source.id}: host "${url.hostname}" is not in the source's allowedHosts`);
  }
}

function headerValue(headers: FetchResponse["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - nowMs);
}

function classifyNetworkError(error: unknown, sourceId: string): ProviderFetchError {
  if (error instanceof ProviderFetchError) return error;
  if (error instanceof BlockedTargetError) {
    return new ProviderFetchError("BLOCKED_TARGET", `${sourceId}: ${error.message}`);
  }
  const named = error as { name?: string; code?: string };
  if (
    named?.name === "AbortError" ||
    named?.name === "TimeoutError" ||
    named?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    named?.code === "UND_ERR_BODY_TIMEOUT" ||
    named?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new ProviderFetchError("TIMEOUT", `${sourceId}: request timed out`);
  }
  return new ProviderFetchError("NETWORK_ERROR", `${sourceId}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Clamps a source's configured cap into [default, ceiling], so a missing, malformed, or over-large value can never widen past 4 MB or shrink below the 512 KB default. */
function resolveMaxBodyBytes(source: FetchProviderSource): number {
  const configured = source.maxBodyBytes;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(MAX_BODY_BYTES_CEILING, Math.max(DEFAULT_MAX_BODY_BYTES, Math.floor(configured)));
}

/** Reads the response body into a Buffer, aborting once the cap is exceeded rather than buffering an unbounded stream. Decoding is deferred so the charset can be chosen from the content-type or a byte-order mark. */
async function readBounded(body: AsyncIterable<Uint8Array>, sourceId: string, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const destroyable = body as { destroy?: () => void };
      destroyable.destroy?.();
      throw new ProviderFetchError("TOO_LARGE", `${sourceId}: response exceeded ${maxBodyBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Decodes a response body to a string, honoring UTF-16. AWS Health serves
 * application/json;charset=utf-16, and a UTF-16 payload read as UTF-8 is
 * mojibake that fails JSON.parse. The charset is taken from a leading
 * byte-order mark first (FF FE little-endian, FE FF big-endian), then from the
 * content-type charset parameter, else UTF-8. Node decodes utf16le natively,
 * so a big-endian body is byte-swapped into little-endian first. The BOM is
 * stripped from the returned string so JSON.parse sees a bare value.
 */
function decodeBody(buffer: Buffer, contentType: string | undefined): string {
  const charset = /charset=\s*"?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return byteSwap16(buffer.subarray(2)).toString("utf16le");
  }
  if (charset === "utf-16" || charset === "utf-16le") {
    return buffer.toString("utf16le");
  }
  if (charset === "utf-16be") {
    return byteSwap16(buffer).toString("utf16le");
  }
  return buffer.toString("utf8");
}

/** Swaps each 16-bit unit's byte order, turning a big-endian UTF-16 buffer into the little-endian layout Node decodes. A trailing odd byte is dropped since it cannot form a code unit. */
function byteSwap16(buffer: Buffer): Buffer {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped;
}

/**
 * Fetches one status-feed document with the security posture the doc
 * requires: HTTPS-only, allowlisted hosts, no IP literals, connection-time
 * private-address rejection (via createSecureLookup), manual redirect
 * handling capped at three hops with every hop re-validated, a 5s deadline,
 * and a streamed body cap (512KB default, raised per source up to 4MB). Sends
 * If-None-Match/If-Modified-Since from the caller's stored validators and
 * returns a not_modified marker on 304. Decodes UTF-16 payloads correctly and,
 * in "text" mode, returns the raw decoded body without JSON.parse.
 * Reuses a caller-supplied dispatcher across a poll cycle's documents when one
 * is given, otherwise opens and closes its own for this call.
 */
export async function fetchProviderDocument(
  source: FetchProviderSource,
  req: FetchProviderRequest,
  deps: FetchProviderDocumentDeps = {},
): Promise<FetchDocumentResult> {
  const resolveAll = deps.resolveAll ?? systemResolveAll;
  const doRequest = deps.request ?? defaultRequest;
  const createDispatcher = deps.createDispatcher ?? defaultCreateDispatcher;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  let currentUrl: URL;
  try {
    currentUrl = new URL(req.url);
  } catch {
    throw new ProviderFetchError("BLOCKED_HOST", `${source.id}: invalid URL "${req.url}"`);
  }

  // A poll cycle passes one shared dispatcher so this source's documents reuse a
  // single keep-alive connection per host. That dispatcher is owned by the
  // caller and is never closed here. Without one, a dispatcher is created for
  // this call, reused across every redirect hop, and closed in the finally.
  // Either way its connect-time secure lookup rejects private addresses on every
  // new connection, so reuse never bypasses the SSRF guard.
  const dispatcher = deps.dispatcher ?? createProviderDispatcher({ resolveAll, createDispatcher });
  const ownsDispatcher = deps.dispatcher == null;
  const maxBodyBytes = resolveMaxBodyBytes(source);
  const acceptHeader = req.mode === "text" ? "*/*" : "application/json";

  let redirects = 0;
  try {
    while (true) {
      assertAllowedUrl(currentUrl, source);
      const remaining = REQUEST_DEADLINE_MS - (now() - startedAt);
      if (remaining <= 0) throw new ProviderFetchError("TIMEOUT", `${source.id}: request deadline exceeded`);

      const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: acceptHeader };
      if (redirects === 0) {
        if (req.validators?.etag) headers["if-none-match"] = req.validators.etag;
        if (req.validators?.lastModified) headers["if-modified-since"] = req.validators.lastModified;
      }

      let response: FetchResponse;
      try {
        response = await doRequest(currentUrl, {
          method: "GET",
          dispatcher,
          headers,
          signal: AbortSignal.timeout(remaining),
          headersTimeout: remaining,
          bodyTimeout: remaining,
          maxRedirections: 0,
        });
      } catch (error) {
        throw classifyNetworkError(error, source.id);
      }

      if (response.statusCode === 304) {
        response.body.destroy();
        return {
          status: "not_modified",
          etag: headerValue(response.headers, "etag") ?? req.validators?.etag ?? null,
          lastModified: headerValue(response.headers, "last-modified") ?? req.validators?.lastModified ?? null,
        };
      }

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        response.body.destroy();
        const location = headerValue(response.headers, "location");
        if (!location) throw new ProviderFetchError("INVALID_REDIRECT", `${source.id}: redirect response had no location`);
        if (redirects >= MAX_REDIRECTS) throw new ProviderFetchError("TOO_MANY_REDIRECTS", `${source.id}: exceeded ${MAX_REDIRECTS} redirects`);
        let destination: URL;
        try {
          destination = new URL(location, currentUrl);
        } catch {
          throw new ProviderFetchError("INVALID_REDIRECT", `${source.id}: redirect location "${location}" is not a valid URL`);
        }
        redirects += 1;
        currentUrl = destination;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy();
        const retryAfterMs = parseRetryAfterMs(headerValue(response.headers, "retry-after"), now());
        throw new ProviderFetchError("HTTP_STATUS", `${source.id}: unexpected status ${response.statusCode}`, response.statusCode, retryAfterMs);
      }

      const bodyBuffer = await readBounded(response.body, source.id, maxBodyBytes);
      const bodyText = decodeBody(bodyBuffer, headerValue(response.headers, "content-type"));
      const etag = headerValue(response.headers, "etag") ?? null;
      const lastModified = headerValue(response.headers, "last-modified") ?? null;

      if (req.mode === "text") {
        return { status: "ok", statusCode: response.statusCode, text: bodyText, etag, lastModified };
      }

      try {
        return { status: "ok", statusCode: response.statusCode, json: JSON.parse(bodyText), etag, lastModified };
      } catch {
        throw new ProviderFetchError("INVALID_JSON", `${source.id}: response body is not valid JSON`);
      }
    }
  } finally {
    if (ownsDispatcher) await dispatcher.close();
  }
}
