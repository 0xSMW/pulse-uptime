import { describe, expect, it, vi } from "vitest"

import {
  type BaseConnector,
  type CheckerDependencies,
  createHttpChecker,
  createSecureConnect,
  type DispatcherFactory,
  runManualCheck,
} from "./checker"
import { BlockedTargetError } from "./ip-policy"
import type { SecureLookup } from "./secure-lookup"
import type {
  CheckerResponse,
  ManagedDispatcher,
  RequestExecutor,
} from "./types"

const target = {
  url: "https://example.com/health",
  method: "GET" as const,
  timeoutMs: 8000,
  expectedStatus: { minimum: 200, maximum: 299 },
}

function response(
  statusCode: number,
  headers: CheckerResponse["headers"] = {}
): CheckerResponse {
  return { statusCode, headers, body: { destroy: vi.fn() } }
}

function harness(
  executor: RequestExecutor,
  extra: Partial<CheckerDependencies> = {}
) {
  const close = vi.fn(async () => undefined)
  const dispatcher = { close } as unknown as ManagedDispatcher
  const createDispatcher = vi.fn<DispatcherFactory>(() => dispatcher)
  const checker = createHttpChecker({
    request: executor,
    createDispatcher,
    ...extra,
  })
  return { checker, close, createDispatcher }
}

/**
 * Test dispatcher: invokes onConnectedAddress only when the request path asks
 * for a peer, simulating connector telemetry without a real socket.
 */
function peerAwareDispatcher(
  peer: string | null | ((origin: string) => string | null)
): { createDispatcher: DispatcherFactory; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined)
  const createDispatcher: DispatcherFactory = ({
    origin,
    onConnectedAddress,
  }) => {
    const address = typeof peer === "function" ? peer(origin) : peer
    return {
      close,
      __reportPeer() {
        if (address) {
          onConnectedAddress(address)
        }
      },
    } as unknown as ManagedDispatcher & { __reportPeer: () => void }
  }
  return { createDispatcher, close }
}

const noopLookup = ((_host, _opts, cb) =>
  cb(null, "8.8.8.8", 4)) as SecureLookup

describe("HTTP checker", () => {
  it("returns terminal response metadata and closes the origin dispatcher", async () => {
    const request = vi.fn(async () => response(204))
    const { checker, close, createDispatcher } = harness(request)
    const result = await checker(target)

    expect(result).toMatchObject({
      success: true,
      mode: "scheduled",
      method: "GET",
      requestedUrl: target.url,
      finalUrl: target.url,
      hostname: "example.com",
      statusCode: 204,
      redirectCount: 0,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(createDispatcher).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("follows only defined redirects and evaluates final status", async () => {
    const request = vi
      .fn<RequestExecutor>()
      .mockResolvedValueOnce(response(302, { location: "/next" }))
      .mockResolvedValueOnce(response(200))
    const { checker, createDispatcher } = harness(request)
    const result = await checker(target)

    expect(result).toMatchObject({
      success: true,
      finalUrl: "https://example.com/next",
      redirectCount: 1,
    })
    expect(createDispatcher).toHaveBeenCalledTimes(1)
  })

  it("uses a separate dispatcher for each redirect origin", async () => {
    const request = vi
      .fn<RequestExecutor>()
      .mockResolvedValueOnce(
        response(301, { location: "https://www.example.org/" })
      )
      .mockResolvedValueOnce(response(200))
    const { checker, createDispatcher, close } = harness(request)
    const result = await checker(target)

    expect(result.success).toBe(true)
    expect(createDispatcher).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("gives missing or unsafe redirect destinations precedence over status validation", async () => {
    const missing = harness(async () => response(302))
    await expect(missing.checker(target)).resolves.toMatchObject({
      errorCode: "INVALID_REDIRECT",
    })

    const blocked = harness(async () =>
      response(302, { location: "http://127.0.0.1/admin" })
    )
    await expect(blocked.checker(target)).resolves.toMatchObject({
      errorCode: "INVALID_REDIRECT",
    })
  })

  it("treats unlisted 3xx responses as terminal", async () => {
    const { checker } = harness(async () =>
      response(304, { location: "/ignored" })
    )
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "INVALID_STATUS",
      redirectCount: 0,
    })
  })

  it("stops after five followed redirects", async () => {
    const { checker } = harness(async () =>
      response(302, { location: "/again" })
    )
    const result = await checker(target)
    expect(result).toMatchObject({
      success: false,
      errorCode: "TOO_MANY_REDIRECTS",
      redirectCount: 5,
    })
  })

  it("validates the redirect destination before applying the redirect limit", async () => {
    let requestCount = 0
    const { checker } = harness(async () => {
      requestCount += 1
      return response(302, {
        location: requestCount === 6 ? "file:///blocked" : "/again",
      })
    })
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "INVALID_REDIRECT",
      redirectCount: 5,
    })
  })

  it("classifies stable transport failures through wrapped causes", async () => {
    const cases = [
      ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"],
      ["ENOTFOUND", "DNS_ERROR"],
      ["ECONNREFUSED", "CONNECTION_REFUSED"],
      ["ECONNRESET", "CONNECTION_RESET"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_ERROR"],
      ["UND_ERR_INVALID_ARG", "RESPONSE_ERROR"],
    ] as const

    for (const [transportCode, checkCode] of cases) {
      const cause = Object.assign(new Error("transport"), {
        code: transportCode,
      })
      const { checker } = harness(async () => {
        throw new TypeError("request failed", { cause })
      })
      await expect(checker(target)).resolves.toMatchObject({
        errorCode: checkCode,
      })
    }
  })

  it("records the second DNS candidate when that is the connected peer", async () => {
    // DNS returns two public candidates. The connector reports the second after
    // the first fails at connect time (Happy-Eyeballs / family failover).
    const { createDispatcher } = peerAwareDispatcher("8.8.4.4")
    const request: RequestExecutor = async (_url, options) => {
      ;(
        options.dispatcher as unknown as { __reportPeer: () => void }
      ).__reportPeer()
      return response(200)
    }
    const checker = createHttpChecker({
      createDispatcher,
      request,
      resolveAll: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "8.8.4.4", family: 4 },
      ],
    })
    await expect(checker(target)).resolves.toMatchObject({
      resolvedAddress: "8.8.4.4",
    })
  })

  it("records IPv4 when IPv6 fails and IPv4 succeeds", async () => {
    const { createDispatcher } = peerAwareDispatcher("199.232.165.91")
    const request: RequestExecutor = async (_url, options) => {
      ;(
        options.dispatcher as unknown as { __reportPeer: () => void }
      ).__reportPeer()
      return response(200)
    }
    const checker = createHttpChecker({
      createDispatcher,
      request,
      resolveAll: async () => [
        { address: "2a04:4e42:69::347", family: 6 },
        { address: "199.232.165.91", family: 4 },
      ],
    })
    await expect(checker(target)).resolves.toMatchObject({
      resolvedAddress: "199.232.165.91",
    })
  })

  it("reuses the recorded peer on keep-alive for the same origin dispatcher", async () => {
    const peers: string[] = []
    const close = vi.fn(async () => undefined)
    let reported = false
    const createDispatcher: DispatcherFactory = ({ onConnectedAddress }) =>
      ({
        close,
        __reportPeer() {
          if (!reported) {
            onConnectedAddress("203.0.113.10")
            reported = true
            peers.push("203.0.113.10")
          }
        },
      }) as unknown as ManagedDispatcher & { __reportPeer: () => void }

    // Same-origin redirect reuses the dispatcher; peer is not re-reported.
    const request = vi
      .fn<RequestExecutor>()
      .mockImplementationOnce(async (_url, options) => {
        ;(
          options.dispatcher as unknown as { __reportPeer: () => void }
        ).__reportPeer()
        return response(302, { location: "/next" })
      })
      .mockImplementationOnce(async (_url, options) => {
        ;(
          options.dispatcher as unknown as { __reportPeer: () => void }
        ).__reportPeer()
        return response(200)
      })

    const checker = createHttpChecker({ createDispatcher, request })
    const result = await checker(target)
    expect(result).toMatchObject({
      success: true,
      resolvedAddress: "203.0.113.10",
      redirectCount: 1,
    })
    expect(peers).toEqual(["203.0.113.10"])
  })

  it("records the final origin peer after a cross-origin redirect", async () => {
    const { createDispatcher } = peerAwareDispatcher((origin) =>
      origin === "https://example.com" ? "203.0.113.1" : "203.0.113.2"
    )
    const request = vi
      .fn<RequestExecutor>()
      .mockImplementationOnce(async (_url, options) => {
        ;(
          options.dispatcher as unknown as { __reportPeer: () => void }
        ).__reportPeer()
        return response(301, { location: "https://www.example.org/" })
      })
      .mockImplementationOnce(async (_url, options) => {
        ;(
          options.dispatcher as unknown as { __reportPeer: () => void }
        ).__reportPeer()
        return response(200)
      })
    const checker = createHttpChecker({ createDispatcher, request })
    await expect(checker(target)).resolves.toMatchObject({
      success: true,
      finalUrl: "https://www.example.org/",
      resolvedAddress: "203.0.113.2",
    })
  })

  it("returns BLOCKED_TARGET when the connector rejects a private peer", async () => {
    const close = vi.fn(async () => undefined)
    const createDispatcher: DispatcherFactory = () =>
      ({
        close,
        __reportPeer() {
          throw new BlockedTargetError()
        },
      }) as unknown as ManagedDispatcher
    const request: RequestExecutor = async (_url, options) => {
      ;(
        options.dispatcher as unknown as { __reportPeer: () => void }
      ).__reportPeer()
      return response(200)
    }
    const checker = createHttpChecker({ createDispatcher, request })
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "BLOCKED_TARGET",
      resolvedAddress: null,
    })
  })

  it("never reports a connected peer when DNS validation fails", async () => {
    const onConnected = vi.fn()
    const baseConnect = vi.fn<BaseConnector>()
    const close = vi.fn(async () => undefined)
    let lookup: Parameters<DispatcherFactory>[0]["lookup"]
    const createDispatcher = vi.fn<DispatcherFactory>((options) => {
      lookup = options.lookup
      const original = options.onConnectedAddress
      const connect = createSecureConnect({
        lookup: options.lookup,
        connectTimeoutMs: options.connectTimeoutMs,
        onConnectedAddress: (address) => {
          onConnected(address)
          original(address)
        },
        baseConnect,
      })
      return {
        close,
        // Expose connect so the request mock can drive it like Undici would.
        __connect: connect,
      } as unknown as ManagedDispatcher
    })
    const request: RequestExecutor = async (_url, options) => {
      const connect = (
        options.dispatcher as unknown as { __connect: BaseConnector }
      ).__connect
      await new Promise<void>((resolve, reject) => {
        // Undici would call lookup inside the base connector. DNS fails first,
        // so the base connector must never be asked to open a socket.
        lookup!("example.com", { all: true }, (error) => {
          if (error) {
            reject(error)
          } else {
            connect(
              { hostname: "example.com", protocol: "https:", port: "443" },
              (connectError, socket) => {
                void socket
                if (connectError) {
                  reject(connectError)
                } else {
                  resolve()
                }
              }
            )
          }
        })
      })
      return response(200)
    }
    const checker = createHttpChecker({
      createDispatcher,
      request,
      resolveAll: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    })
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "BLOCKED_TARGET",
      resolvedAddress: null,
    })
    expect(onConnected).not.toHaveBeenCalled()
    expect(baseConnect).not.toHaveBeenCalled()
  })

  it("leaves resolvedAddress null when no connection is established", async () => {
    const onConnected = vi.fn()
    const createDispatcher: DispatcherFactory = ({ onConnectedAddress }) =>
      ({
        close: async () => undefined,
        // Intentionally never call onConnectedAddress.
        __noop: onConnectedAddress,
      }) as unknown as ManagedDispatcher
    const request: RequestExecutor = async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
    }
    const checker = createHttpChecker({ createDispatcher, request })
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "CONNECTION_REFUSED",
      resolvedAddress: null,
    })
    expect(onConnected).not.toHaveBeenCalled()
  })

  it("returns manual mode without changing checker semantics", async () => {
    const close = vi.fn(async () => undefined)
    const result = await runManualCheck(
      "https://example.com",
      {},
      {
        request: async () => response(200),
        createDispatcher: () => ({ close }) as unknown as ManagedDispatcher,
      }
    )
    expect(result).toMatchObject({ success: true, mode: "manual" })
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects invalid target configuration before dispatch", async () => {
    const request = vi.fn(async () => response(200))
    const { checker, createDispatcher } = harness(request)
    await expect(
      checker({ ...target, url: "file:///etc/passwd" })
    ).resolves.toMatchObject({
      errorCode: "INVALID_URL",
    })
    expect(request).not.toHaveBeenCalled()
    expect(createDispatcher).not.toHaveBeenCalled()
  })

  it("distinguishes a blocked literal from a malformed URL", async () => {
    const { checker } = harness(async () => response(200))
    await expect(
      checker({ ...target, url: "http://127.0.0.1" })
    ).resolves.toMatchObject({
      errorCode: "BLOCKED_TARGET",
    })
  })
})

describe("createSecureConnect", () => {
  const connectOpts = {
    hostname: "example.com",
    protocol: "https:",
    port: "443",
  }

  it("records a public remoteAddress from the established socket", async () => {
    const onConnectedAddress = vi.fn()
    const destroy = vi.fn()
    const baseConnect: BaseConnector = (_opts, callback) => {
      callback(null, { remoteAddress: "8.8.8.8", destroy } as never)
    }
    const connect = createSecureConnect({
      lookup: noopLookup,
      connectTimeoutMs: 1000,
      onConnectedAddress,
      baseConnect,
    })
    const socket = await new Promise<unknown>((resolve, reject) => {
      connect(connectOpts, (error, value) => {
        if (error) {
          reject(error)
        } else {
          resolve(value)
        }
      })
    })
    expect(socket).toMatchObject({ remoteAddress: "8.8.8.8" })
    expect(onConnectedAddress).toHaveBeenCalledWith("8.8.8.8")
    expect(destroy).not.toHaveBeenCalled()
  })

  it("destroys the socket and rejects a private peer without recording it", async () => {
    const onConnectedAddress = vi.fn()
    const destroy = vi.fn()
    const baseConnect: BaseConnector = (_opts, callback) => {
      callback(null, { remoteAddress: "10.0.0.5", destroy } as never)
    }
    const connect = createSecureConnect({
      lookup: noopLookup,
      connectTimeoutMs: 1000,
      onConnectedAddress,
      baseConnect,
    })
    const error = await new Promise<Error>((resolve) => {
      connect(connectOpts, (err, socket) => {
        void socket
        resolve(err as Error)
      })
    })
    expect(error).toBeInstanceOf(BlockedTargetError)
    expect(destroy).toHaveBeenCalled()
    expect(onConnectedAddress).not.toHaveBeenCalled()
  })

  it("propagates base connector failures without a peer", async () => {
    const onConnectedAddress = vi.fn()
    const baseError = Object.assign(new Error("refused"), {
      code: "ECONNREFUSED",
    })
    const baseConnect: BaseConnector = (_opts, callback) => {
      callback(baseError, null)
    }
    const connect = createSecureConnect({
      lookup: noopLookup,
      connectTimeoutMs: 1000,
      onConnectedAddress,
      baseConnect,
    })
    const error = await new Promise<Error>((resolve) => {
      connect(connectOpts, (err, socket) => {
        void socket
        resolve(err as Error)
      })
    })
    expect(error).toBe(baseError)
    expect(onConnectedAddress).not.toHaveBeenCalled()
  })
})
