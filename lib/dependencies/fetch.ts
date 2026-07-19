import "server-only";

import { Agent, request as undiciRequest, type Dispatcher } from "undici";

import { BlockedTargetError, isIpLiteral } from "@/lib/checker/ip-policy";
import { createSecureLookup, systemResolveAll, type ResolveAll, type SecureLookup } from "@/lib/checker/secure-lookup";

// Dependency polling needs to read a response body, unlike the endpoint
// checker which destroys it by design. This module adds the controls the
// checker never needed: a catalog host allowlist, a hard body cap, and
// conditional-request validators, while reusing the same connect-time DNS
// pinning so a status-feed host can never resolve to a private address.

const MAX_BODY_BYTES = 512 * 1024;
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
}

export interface FetchProviderRequest {
  url: string;
  validators?: FetchValidators;
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
  now?: () => number;
}

const defaultRequest: FetchRequestExecutor = async (url, options) =>
  undiciRequest(url, options) as Promise<FetchResponse>;

const defaultCreateDispatcher: FetchDispatcherFactory = ({ lookup, connectTimeoutMs }) =>
  new Agent({ connect: { lookup, timeout: connectTimeoutMs }, connections: 1, pipelining: 0 });

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

/** Reads the response body as text, aborting once the cap is exceeded rather than buffering an unbounded stream. */
async function readBounded(body: AsyncIterable<Uint8Array>, sourceId: string): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const destroyable = body as { destroy?: () => void };
      destroyable.destroy?.();
      throw new ProviderFetchError("TOO_LARGE", `${sourceId}: response exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches one status-feed document with the security posture the doc
 * requires: HTTPS-only, allowlisted hosts, no IP literals, connection-time
 * private-address rejection (via createSecureLookup), manual redirect
 * handling capped at three hops with every hop re-validated, a 5s deadline,
 * and a 512KB streamed body cap. Sends If-None-Match/If-Modified-Since from
 * the caller's stored validators and returns a not_modified marker on 304.
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

  let redirects = 0;
  let dispatcher: ManagedDispatcher | null = null;
  try {
    while (true) {
      assertAllowedUrl(currentUrl, source);
      const remaining = REQUEST_DEADLINE_MS - (now() - startedAt);
      if (remaining <= 0) throw new ProviderFetchError("TIMEOUT", `${source.id}: request deadline exceeded`);

      const lookup = createSecureLookup({ resolveAll });
      dispatcher = createDispatcher({ lookup, connectTimeoutMs: remaining });

      const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
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
        await dispatcher.close();
        dispatcher = null;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy();
        const retryAfterMs = parseRetryAfterMs(headerValue(response.headers, "retry-after"), now());
        throw new ProviderFetchError("HTTP_STATUS", `${source.id}: unexpected status ${response.statusCode}`, response.statusCode, retryAfterMs);
      }

      const bodyText = await readBounded(response.body, source.id);
      const etag = headerValue(response.headers, "etag") ?? null;
      const lastModified = headerValue(response.headers, "last-modified") ?? null;

      try {
        return { status: "ok", statusCode: response.statusCode, json: JSON.parse(bodyText), etag, lastModified };
      } catch {
        throw new ProviderFetchError("INVALID_JSON", `${source.id}: response body is not valid JSON`);
      }
    }
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}
