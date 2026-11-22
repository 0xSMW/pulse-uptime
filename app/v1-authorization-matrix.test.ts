/// <reference types="vite/client" />

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  ADMINISTRATOR_SCOPES,
  type ApiScope,
  VIEWER_SCOPES,
} from "@/lib/api/scopes"

const { authenticateMock, rateLimitMock, replayMock, admission } = vi.hoisted(
  () => ({
    authenticateMock: vi.fn(),
    rateLimitMock: vi.fn(async () => ({ allowed: true })),
    replayMock: vi.fn(async () => null),
    admission: { continueAfterGuard: false },
  })
)

vi.mock("server-only", () => ({}))
vi.mock("@/lib/api/principal", () => ({
  authenticatePrincipal: authenticateMock,
}))
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rate-limit")>()),
  enforceRateLimit: rateLimitMock,
}))
vi.mock("@/lib/api/device-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/device-authorization")>()),
  resolveRevokedCliRevokeReplay: replayMock,
}))
vi.mock("@/lib/api/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/middleware")>()
  return {
    ...actual,
    // Admit or reject through the real middleware, then stop accepted calls
    // before route-specific business effects. This isolates the HTTP guard.
    authorize: vi.fn(async (...args: Parameters<typeof actual.authorize>) => {
      const outcome = await actual.authorize(...args)
      return outcome instanceof Response || admission.continueAfterGuard
        ? outcome
        : new Response("admitted", { status: 299 })
    }),
  }
})

import { authorize } from "@/lib/api/middleware"
import type { Principal } from "@/lib/api/principal"

type Handler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> }
) => Promise<Response>
interface Operation {
  path: string
  method: string
  scope: ApiScope | null
  handler: Handler
}

const publicOperations = new Set([
  "GET /api/v1/version",
  "POST /api/v1/cli-auth/device",
  "POST /api/v1/cli-auth/token",
])
const humanOnlyOperations = [
  "PATCH /api/v1/me",
  "POST /api/v1/me/email",
  "POST /api/v1/me/password",
  "DELETE /api/v1/me/sessions/{sessionId}",
  "POST /api/v1/me/sessions/revoke-others",
  "GET /api/v1/images/{imageId}",
  "DELETE /api/v1/cli-auth/installations/{installationId}",
  "POST /api/v1/cli-auth/installations/revoke-all",
]
const routeModules = import.meta.glob<Record<string, Handler>>(
  "./api/v1/**/route.ts"
)
const httpMethods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
])
const contract = JSON.parse(
  readFileSync(join(process.cwd(), "openapi", "service.openapi.yaml"), "utf8")
) as {
  paths: Record<string, Record<string, unknown>>
  components: { pathItems: Record<string, Record<string, unknown>> }
}

function pathItem(raw: Record<string, unknown>): Record<string, unknown> {
  const reference = raw.$ref
  return typeof reference === "string"
    ? contract.components.pathItems[reference.split("/").at(-1)!]!
    : raw
}

function routeModulePath(path: string): string {
  return `./${path.slice(1).replace(/\{([^}]+)\}/g, "[$1]")}/route.ts`
}

function httpPathFromModule(file: string): string {
  const segments = file
    .replace(/^\.\//, "")
    .replace(/\/route\.ts$/, "")
    .split("/")
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(.+)\]$/, "{$1}"))
  return `/${segments.join("/")}`
}

function routeRequest(operation: Operation, crossOrigin = false) {
  const params: Record<string, string> = {}
  const concretePath = operation.path.replace(
    /\{([^}]+)\}/g,
    (_, name: string) => {
      params[name] = "11111111-1111-4111-8111-111111111111"
      return params[name]!
    }
  )
  return {
    request: new Request(`https://pulse.test${concretePath}`, {
      method: operation.method,
      headers: {
        Origin: crossOrigin ? "https://elsewhere.test" : "https://pulse.test",
      },
    }),
    context: { params: Promise.resolve(params) },
  }
}

function human(role: "viewer" | "admin"): Principal {
  return {
    type: "human",
    id: role,
    sessionId: `session-${role}`,
    email: `${role}@example.com`,
    role,
    scopes: role === "admin" ? [...ADMINISTRATOR_SCOPES] : [...VIEWER_SCOPES],
  }
}

function machine(
  type: "api_token" | "cli_session",
  scopes: ApiScope[]
): Principal {
  const expiry = new Date("2099-01-01")
  return type === "api_token"
    ? { type, id: "token-1", name: "test", scopes, expiresAt: expiry }
    : {
        type,
        id: "cli-1",
        email: "admin@example.com",
        scopes,
        expiresAt: expiry,
        installation: {
          id: "installation-1",
          displayName: "test",
          platform: "darwin",
          architecture: "arm64",
          clientVersion: "1.0.0",
          linkedAt: new Date("2026-01-01"),
        },
      }
}

const operations = Object.entries(contract.paths).flatMap(([path, raw]) =>
  Object.entries(pathItem(raw))
    .filter(([method]) =>
      ["get", "post", "put", "patch", "delete"].includes(method)
    )
    .map(([method, definition]) => {
      const scope =
        (definition as { "x-required-scopes"?: ApiScope[] })[
          "x-required-scopes"
        ]?.[0] ?? null
      return { path, method: method.toUpperCase(), scope }
    })
)

beforeEach(() => {
  vi.mocked(authorize).mockClear()
  authenticateMock.mockReset()
  rateLimitMock.mockClear()
  replayMock.mockReset().mockResolvedValue(null)
  admission.continueAfterGuard = false
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pulse.test")
})

describe("v1 HTTP admission matrix", () => {
  it("matches the exact implemented HTTP method/path set", async () => {
    expect(operations).toHaveLength(74)
    const implemented: string[] = []
    for (const [file, load] of Object.entries(routeModules)) {
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
      operations
        .map(({ method, path }) => `${method} ${path}`)
        .sort((a, b) => a.localeCompare(b))
    )
  }, 30_000)

  it.each(
    operations.filter(
      ({ path, method }) => !publicOperations.has(`${method} ${path}`)
    )
  )(
    "$method $path admits only actors with its required scope",
    async ({ path, method, scope }) => {
      const module = await routeModules[routeModulePath(path)]!()
      const operation: Operation = {
        path,
        method,
        scope,
        handler: module[method]!,
      }
      const invoke = async (
        principal: Principal | null,
        crossOrigin = false
      ) => {
        authenticateMock.mockResolvedValueOnce(principal)
        const { request, context } = routeRequest(operation, crossOrigin)
        const response = await operation.handler(request, context)
        return response.status
      }

      expect(await invoke(null), "anonymous").toBe(401)
      for (const state of ["stale", "revoked", "expired"]) {
        // A failed principal lookup is the route boundary for each state;
        // expiry/revocation lookup conditions are covered in principal/service tests.
        expect(await invoke(null), state).toBe(401)
      }
      expect(await invoke(human("viewer")), "viewer").toBe(
        scope && !VIEWER_SCOPES.includes(scope) ? 403 : 299
      )
      expect(await invoke(human("admin")), "administrator").toBe(299)
      expect(
        await invoke(machine("api_token", scope ? [scope] : [])),
        "scoped token"
      ).toBe(299)
      expect(
        await invoke(machine("cli_session", scope ? [scope] : [])),
        "scoped CLI"
      ).toBe(299)
      if (scope) {
        expect(await invoke(machine("api_token", [])), "unscoped token").toBe(
          403
        )
        expect(await invoke(machine("cli_session", [])), "unscoped CLI").toBe(
          403
        )
      }
      expect(await invoke(human("admin"), true), "cross-origin human").toBe(
        method === "GET" ? 299 : 403
      )
      expect(vi.mocked(authorize).mock.calls.length).toBeGreaterThan(0)
    }
  )

  it.each(humanOnlyOperations)(
    "%s rejects machine credentials after scope admission",
    async (key) => {
      const operation = operations.find(
        ({ method, path }) => `${method} ${path}` === key
      )!
      const module = await routeModules[routeModulePath(operation.path)]!()
      admission.continueAfterGuard = true
      for (const type of ["api_token", "cli_session"] as const) {
        authenticateMock.mockResolvedValueOnce(
          machine(type, operation.scope ? [operation.scope] : [])
        )
        const { request, context } = routeRequest({
          ...operation,
          handler: module[operation.method]!,
        })
        const response = await module[operation.method]!(request, context)
        expect(response.status, `${key} with ${type}`).toBe(403)
        expect((await response.json()).error.code).toBe("SESSION_REQUIRED")
      }
    }
  )
})
