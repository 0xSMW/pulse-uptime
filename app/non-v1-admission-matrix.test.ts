/// <reference types="vite/client" />

import { beforeEach, describe, expect, it, vi } from "vitest"

const { sessionMock, rateLimitMock, findImageMock, displayConfigMock } =
  vi.hoisted(() => ({
    sessionMock: vi.fn(),
    rateLimitMock: vi.fn(async () => ({ allowed: true })),
    findImageMock: vi.fn(async () => null),
    displayConfigMock: vi.fn(async () => ({ customCss: "" })),
  }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  authenticateCurrentSession: sessionMock,
}))
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rate-limit")>()),
  enforceRateLimit: rateLimitMock,
}))
vi.mock("@/lib/db/query-executor", () => ({
  queryExecutor: {
    withStatementTimeout: vi.fn(
      async (
        _timeout: number,
        work: (query: () => Promise<unknown[]>) => Promise<unknown>
      ) => work(async () => [{}])
    ),
  },
}))
vi.mock("@/lib/api/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/images")>()),
  findImage: findImageMock,
}))
vi.mock("@/lib/reporting/queries/status", () => ({
  getStatusPageDisplayConfig: displayConfigMock,
}))

type Handler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> }
) => Promise<Response>

const routeModules = import.meta.glob<Record<string, Handler>>("./**/route.ts")
const httpMethods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
])
const operations = [
  "POST /api/auth/login",
  "POST /api/auth/join",
  "POST /api/auth/logout",
  "POST /api/onboarding/account",
  "GET /api/onboarding/readiness",
  "POST /api/onboarding/draft",
  "POST /api/onboarding/back",
  "POST /api/onboarding/complete",
  "POST /api/onboarding/verify",
  "POST /api/onboarding/activate",
  "GET /api/cron/check-monitors",
  "GET /api/cron/check-dependencies",
  "GET /api/cron/check-domains",
  "GET /api/cron/maintenance",
  "GET /api/cron/sweep",
  "GET /api/cron/deploy-proof",
  "POST /api/webhooks/porkbun",
  "GET /api/health",
  "GET /openapi/v1.json",
  "GET /status/assets/{imageId}",
  "GET /status/custom.css",
] as const

function httpPathFromModule(file: string): string {
  const segments = file
    .replace(/^\.\//, "")
    .replace(/\/route\.ts$/, "")
    .split("/")
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(.+)\]$/, "{$1}"))
  return `/${segments.join("/")}`
}

function operationHandler(operation: string) {
  const [method, path] = operation.split(" ")
  const file = `./${path!.slice(1).replace(/\{([^}]+)\}/g, "[$1]")}/route.ts`
  const load = routeModules[file]
  if (!load) {
    throw new Error(`No route file for ${operation}`)
  }
  return { method: method!, path: path!, load }
}

function request(
  operation: string,
  options: {
    origin?: string
    authorization?: string
    bootstrapToken?: string
    body?: unknown
  } = {}
) {
  const { method, path } = operationHandler(operation)
  const concretePath = path.replace(
    /\{[^}]+\}/g,
    "11111111-1111-4111-8111-111111111111"
  )
  const headers = new Headers()
  if (options.origin) {
    headers.set("origin", options.origin)
  }
  if (options.authorization) {
    headers.set("authorization", options.authorization)
  }
  if (options.bootstrapToken) {
    headers.set("x-pulse-bootstrap-token", options.bootstrapToken)
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json")
  }
  return new Request(`https://pulse.test${concretePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function invoke(
  operation: string,
  options?: Parameters<typeof request>[1]
) {
  const { method, load } = operationHandler(operation)
  const route = await load()
  const handler = route[method]
  expect(handler, operation).toBeTypeOf("function")
  return handler!(request(operation, options), {
    params: Promise.resolve({
      imageId: "11111111-1111-4111-8111-111111111111",
    }),
  })
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pulse.test")
  vi.stubEnv("PULSE_BOOTSTRAP_TOKEN", "operator-held-bootstrap-secret-123")
  vi.stubEnv("CRON_SECRET", "cron-secret-12345678901234567890")
  vi.stubEnv("API_TOKEN_HASH_KEY", "test-hash-key-with-at-least-32-characters")
  sessionMock.mockReset().mockResolvedValue(null)
  rateLimitMock.mockReset().mockResolvedValue({ allowed: true })
  findImageMock.mockReset().mockResolvedValue(null)
  displayConfigMock.mockReset().mockResolvedValue({ customCss: "" })
})

describe("non-v1 HTTP admission matrix", () => {
  it("matches the exact implemented HTTP method/path set", async () => {
    expect(operations).toHaveLength(21)
    const implemented: string[] = []
    for (const [file, load] of Object.entries(routeModules)) {
      if (file.startsWith("./api/v1/")) {
        continue
      }
      const path = httpPathFromModule(file)
      const module = await load()
      for (const [method, handler] of Object.entries(module)) {
        if (httpMethods.has(method)) {
          expect(handler, `${method} ${path}`).toBeTypeOf("function")
          implemented.push(`${method} ${path}`)
        }
      }
    }
    expect(implemented.sort((a, b) => a.localeCompare(b))).toEqual(
      [...operations].sort((a, b) => a.localeCompare(b))
    )
  }, 30_000)

  it.each([
    "POST /api/auth/login",
    "POST /api/auth/join",
    "POST /api/auth/logout",
    "POST /api/onboarding/account",
  ])(
    "%s rejects a cross-origin mutation before service work",
    async (operation) => {
      expect(
        (await invoke(operation, { origin: "https://elsewhere.test" })).status
      ).toBe(403)
    }
  )

  it.each([
    "POST /api/onboarding/draft",
    "POST /api/onboarding/back",
    "POST /api/onboarding/complete",
    "POST /api/onboarding/verify",
    "POST /api/onboarding/activate",
  ])("%s denies anonymous and cross-origin callers", async (operation) => {
    expect(
      (await invoke(operation, { origin: "https://pulse.test" })).status
    ).toBe(401)
    expect(
      (await invoke(operation, { origin: "https://elsewhere.test" })).status
    ).toBe(403)
  })

  it.each(["POST /api/onboarding/verify", "POST /api/onboarding/activate"])(
    "%s denies a viewer before probe or activation",
    async (operation) => {
      sessionMock.mockResolvedValue({ userId: "viewer-1", role: "viewer" })
      expect(
        (await invoke(operation, { origin: "https://pulse.test" })).status
      ).toBe(403)
    }
  )

  it("requires a valid bootstrap token for first-admin creation and readiness", async () => {
    const account = {
      email: "admin@example.com",
      password: "StrongPassphrase123!",
      passwordConfirmation: "StrongPassphrase123!",
    }
    expect(
      (
        await invoke("POST /api/onboarding/account", {
          origin: "https://pulse.test",
          body: account,
        })
      ).status
    ).toBe(403)
    expect((await invoke("GET /api/onboarding/readiness")).status).toBe(403)
    expect(
      (
        await invoke("GET /api/onboarding/readiness", {
          bootstrapToken: "wrong",
        })
      ).status
    ).toBe(403)
    sessionMock.mockResolvedValue({ userId: "viewer-1", role: "viewer" })
    expect((await invoke("GET /api/onboarding/readiness")).status).toBe(403)
  })

  it.each(
    operations.filter((operation) => operation.startsWith("GET /api/cron/"))
  )("%s requires the exact cron bearer secret", async (operation) => {
    expect((await invoke(operation)).status).toBe(401)
    expect(
      (await invoke(operation, { authorization: "Bearer wrong" })).status
    ).toBe(401)
  })

  it("rejects an unsigned Porkbun webhook at ingress", async () => {
    expect(
      (
        await invoke("POST /api/webhooks/porkbun", {
          body: { event: "domain.updated" },
        })
      ).status
    ).toBe(400)
  })

  it("keeps public read routes callable without a credential", async () => {
    expect((await invoke("GET /api/health")).status).toBe(200)
    expect((await invoke("GET /openapi/v1.json")).status).toBe(200)
    expect((await invoke("GET /status/assets/{imageId}")).status).toBe(404)
    expect((await invoke("GET /status/custom.css")).status).toBe(200)
  })
})
