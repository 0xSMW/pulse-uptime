import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { Agent, buildConnector, request as undiciRequest } from "undici"

import { classifyCheckError, ERROR_MESSAGES } from "./classify-error"
import {
  assertPublicAddress,
  BlockedTargetError,
  isIpLiteral,
  normalizeIpLiteral,
} from "./ip-policy"
import {
  createSecureLookup,
  type ResolveAll,
  type SecureLookup,
  systemResolveAll,
} from "./secure-lookup"
import type {
  CheckErrorCode,
  CheckerResponse,
  CheckMode,
  CheckResult,
  CheckTarget,
  ManagedDispatcher,
  RequestExecutor,
} from "./types"
import { parsePublicHttpUrl, validateCheckTarget } from "./validation"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = "Pulse-Uptime/1.0"

export type DispatcherFactory = (options: {
  origin: string
  lookup: SecureLookup
  connectTimeoutMs: number
  /** Fires once per newly established peer for this dispatcher. */
  onConnectedAddress: (address: string) => void
}) => ManagedDispatcher

export interface CheckerDependencies {
  resolveAll?: ResolveAll
  request?: RequestExecutor
  createDispatcher?: DispatcherFactory
  now?: () => number
  userAgent?: string
}

type ConnectorCallback = (
  ...args: [null, Socket | TLSSocket] | [Error, null]
) => void
interface ConnectorOptions {
  hostname: string
  host?: string
  protocol: string
  port: string
  servername?: string
  localAddress?: string | null
  socketPath?: string | null
  httpSocket?: Socket
}
export type BaseConnector = (
  options: ConnectorOptions,
  callback: ConnectorCallback
) => void

const defaultRequest: RequestExecutor = async (url, options) =>
  undiciRequest(url, options) as Promise<CheckerResponse>

/**
 * Wraps Undici's connector so the check records the peer Undici actually
 * connected to after family failover, and rejects a private remoteAddress even
 * if DNS already filtered candidates.
 */
export function createSecureConnect(options: {
  lookup: SecureLookup
  connectTimeoutMs: number
  onConnectedAddress: (address: string) => void
  /** Test seam: inject a fake base connector instead of buildConnector. */
  baseConnect?: BaseConnector
}): BaseConnector {
  const connect: BaseConnector =
    options.baseConnect ??
    (buildConnector({
      lookup: options.lookup,
      timeout: options.connectTimeoutMs,
    }) as BaseConnector)

  return function secureConnect(opts, callback) {
    connect(opts, (error, socket) => {
      if (error || !socket) {
        callback(error ?? new Error("Connection failed"), null)
        return
      }
      try {
        const remote = socket.remoteAddress
        if (!remote) {
          socket.destroy()
          callback(
            new BlockedTargetError("Connected peer address is unavailable"),
            null
          )
          return
        }
        const address = normalizeIpLiteral(remote)
        assertPublicAddress(address)
        options.onConnectedAddress(address)
        callback(null, socket)
      } catch (peerError) {
        socket.destroy()
        callback(peerError as Error, null)
      }
    })
  }
}

const defaultDispatcherFactory: DispatcherFactory = ({
  lookup,
  connectTimeoutMs,
  onConnectedAddress,
}) =>
  new Agent({
    connect: createSecureConnect({
      lookup,
      connectTimeoutMs,
      onConnectedAddress,
    }),
    connections: 1,
    pipelining: 0,
  })

function headerValue(
  headers: CheckerResponse["headers"],
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function failure(
  metadata: Omit<CheckResult, "success" | "errorCode" | "errorMessage">,
  errorCode: CheckErrorCode
): CheckResult {
  return {
    ...metadata,
    success: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode],
  }
}

export function createHttpChecker(dependencies: CheckerDependencies = {}) {
  const resolveAll = dependencies.resolveAll ?? systemResolveAll
  const executeRequest = dependencies.request ?? defaultRequest
  const createDispatcher =
    dependencies.createDispatcher ?? defaultDispatcherFactory
  const now = dependencies.now ?? Date.now
  const userAgent = dependencies.userAgent ?? DEFAULT_USER_AGENT

  return async function check(
    input: CheckTarget,
    options: { mode?: CheckMode } = {}
  ): Promise<CheckResult> {
    const mode = options.mode ?? "scheduled"
    const startedAt = now()
    let currentUrl: URL
    let method = input.method
    let redirects = 0
    let statusCode: number | null = null
    let resolvedAddress: string | null = null
    const dispatchers = new Map<string, ManagedDispatcher>()
    // Peer recorded for each origin after a successful connect. Reused for
    // keep-alive on the same dispatcher so a second hop does not invent a peer.
    const connectedAddresses = new Map<string, string>()

    const metadata = () => ({
      mode,
      method,
      requestedUrl: input.url,
      finalUrl: currentUrl?.href ?? input.url,
      hostname: currentUrl?.hostname ?? "",
      resolvedAddress,
      statusCode,
      latencyMs: Math.max(0, now() - startedAt),
      redirectCount: redirects,
    })

    try {
      // Parse first so a blocked literal retains BLOCKED_TARGET rather than being
      // flattened into an ordinary schema-validation failure.
      currentUrl = parsePublicHttpUrl(input.url)
      const target = validateCheckTarget(input)

      while (true) {
        const remaining = target.timeoutMs - (now() - startedAt)
        if (remaining <= 0) {
          return failure(metadata(), "TIMEOUT")
        }

        const origin = currentUrl.origin
        let dispatcher = dispatchers.get(origin)
        if (dispatcher) {
          resolvedAddress = connectedAddresses.get(origin) ?? null
        } else {
          if (isIpLiteral(currentUrl.hostname)) {
            // Reject private literals before a connector is built.
            assertPublicAddress(normalizeIpLiteral(currentUrl.hostname))
          }
          const lookup = createSecureLookup({ resolveAll })
          dispatcher = createDispatcher({
            origin,
            lookup,
            connectTimeoutMs: remaining,
            onConnectedAddress: (address) => {
              connectedAddresses.set(origin, address)
              resolvedAddress = address
            },
          })
          dispatchers.set(origin, dispatcher)
        }

        let response: CheckerResponse
        try {
          response = await executeRequest(currentUrl, {
            method,
            dispatcher,
            signal: AbortSignal.timeout(remaining),
            headersTimeout: remaining,
            bodyTimeout: remaining,
            maxRedirections: 0,
            headers: { "user-agent": userAgent },
          })
        } catch (error) {
          // No confirmed peer for this origin means null, even after a failed connect.
          resolvedAddress = connectedAddresses.get(origin) ?? null
          return failure(metadata(), classifyCheckError(error))
        }

        resolvedAddress = connectedAddresses.get(origin) ?? null

        statusCode = response.statusCode
        response.body.destroy()

        if (REDIRECT_STATUSES.has(statusCode)) {
          const location = headerValue(response.headers, "location")
          if (!location) {
            return failure(metadata(), "INVALID_REDIRECT")
          }

          let destination: URL
          try {
            destination = parsePublicHttpUrl(new URL(location, currentUrl).href)
          } catch {
            return failure(metadata(), "INVALID_REDIRECT")
          }
          if (redirects >= MAX_REDIRECTS) {
            return failure(metadata(), "TOO_MANY_REDIRECTS")
          }

          redirects += 1
          if (statusCode === 303 && method !== "HEAD") {
            method = "GET"
          }
          currentUrl = destination
          continue
        }

        if (
          statusCode < target.expectedStatus.minimum ||
          statusCode > target.expectedStatus.maximum
        ) {
          return failure(metadata(), "INVALID_STATUS")
        }

        return {
          ...metadata(),
          success: true,
          errorCode: null,
          errorMessage: null,
        }
      }
    } catch (error) {
      return failure(metadata(), classifyCheckError(error))
    } finally {
      await Promise.allSettled(
        [...dispatchers.values()].map((dispatcher) => dispatcher.close())
      )
    }
  }
}

export const checkHttpEndpoint = createHttpChecker()

export function checkMonitor(
  target: CheckTarget,
  dependencies?: CheckerDependencies
) {
  return createHttpChecker(dependencies)(target, { mode: "scheduled" })
}

export function runManualCheck(
  url: string,
  options: Partial<Omit<CheckTarget, "url">> & { userAgent?: string } = {},
  dependencies: CheckerDependencies = {}
) {
  return createHttpChecker({
    ...dependencies,
    userAgent: options.userAgent ?? dependencies.userAgent,
  })(
    {
      url,
      method: options.method ?? "GET",
      timeoutMs: options.timeoutMs ?? 8000,
      expectedStatus: options.expectedStatus ?? { minimum: 200, maximum: 399 },
    },
    { mode: "manual" }
  )
}
