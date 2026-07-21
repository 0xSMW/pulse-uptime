import { beforeEach, describe, expect, it, vi } from "vitest"

const { idempotencyRecords } = vi.hoisted(() => ({
  idempotencyRecords: new Map<
    string,
    { status: number; body: unknown; operationId: string }
  >(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db/client", () => ({ db: {} }))
vi.mock("@/lib/api/middleware", () => ({
  authorize: vi.fn(),
  isApiResponse: (value: unknown) => value instanceof Response,
}))
// Mimics executeIdempotent persistBody / replayBody so create+replay contracts
// can be asserted without a database.
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(
    async <T>({
      request: incomingRequest,
      work,
      persistBody,
      replayBody,
    }: {
      request: Request
      work: (context: {
        operationId: string
        transaction: (
          run: (tx: unknown) => Promise<{ status: number; body: T }>
        ) => Promise<{ status: number; body: T }>
      }) => Promise<{ status: number; body: T }>
      persistBody?: (body: T) => unknown
      replayBody?: (
        stored: unknown,
        context: { operationId: string; transaction: never }
      ) => T | Promise<T>
    }) => {
      const key = incomingRequest.headers.get("idempotency-key")!
      const existing = idempotencyRecords.get(key)
      if (existing) {
        const body = replayBody
          ? await replayBody(existing.body, {
              operationId: existing.operationId,
              transaction: undefined as never,
            })
          : (existing.body as T)
        return { status: existing.status, body, replayed: true }
      }
      const operationId = "op-token-1"
      const result = await work({
        operationId,
        transaction: async (run) => {
          const outcome = await run("tx")
          idempotencyRecords.set(key, {
            status: outcome.status,
            body: persistBody ? persistBody(outcome.body) : outcome.body,
            operationId,
          })
          return outcome
        },
      })
      return { ...result, replayed: false }
    }
  ),
}))
vi.mock("@/lib/api/token-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/token-service")>()),
  createApiToken: vi.fn(),
  validateTokenInput: vi.fn(),
}))
vi.mock("@/lib/api/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/tokens")>()),
  deriveBearerToken: vi.fn(() => ({
    raw: "pulse_live_derived-secret-value-aaaaaaaaaaa",
    prefix: "pulse_live_derived",
    digest: Buffer.alloc(32, 7),
  })),
  credentialDerivationContext: vi.fn(() => "derived-context"),
}))

import { type ApiContext, authorize } from "@/lib/api/middleware"
import type { ApiScope } from "@/lib/api/scopes"
import {
  createApiToken,
  type TokenRecord,
  validateTokenInput,
} from "@/lib/api/token-service"

import {
  type CreatedTokenData,
  type PersistedCreatedTokenData,
  POST,
  persistCreatedToken,
  replayCreatedToken,
} from "./route"

const humanContext: ApiContext = {
  principal: {
    type: "human",
    id: "user-1",
    email: "admin@example.com",
    scopes: ["tokens:manage", "monitors:read"],
  },
  principalKey: "human:user-1",
  requestId: "req_tokens",
}

const cliContext: ApiContext = {
  principal: {
    type: "cli_session",
    id: "cli-1",
    email: "admin@example.com",
    scopes: ["tokens:manage", "monitors:read"],
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    installation: {
      id: "ins-1",
      displayName: "Mac",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.0.0",
      linkedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  },
  principalKey: "cli_session:cli-1",
  requestId: "req_tokens_cli",
}

const tokenRecord: TokenRecord = {
  id: "tok-1",
  name: "Deploy",
  scopes: ["monitors:read"] as ApiScope[],
  createdAt: new Date("2026-07-18T12:00:00.000Z"),
  expiresAt: new Date("2026-10-16T12:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
}

function request(body: unknown, key = "00000000-0000-4000-8000-0000000000aa") {
  return new Request("https://pulse.test/api/v1/tokens", {
    method: "POST",
    headers: { "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function createAndReplay(context: ApiContext, clamped: boolean) {
  vi.mocked(authorize).mockResolvedValue(context)
  vi.mocked(validateTokenInput).mockReturnValue({
    name: "Deploy",
    scopes: ["monitors:read"],
    expiresAt: tokenRecord.expiresAt,
    clamped,
  })
  vi.mocked(createApiToken).mockResolvedValue({
    token: tokenRecord,
    secret: "pulse_live_derived-secret-value-aaaaaaaaaaa",
  })

  const key = crypto.randomUUID()
  const first = await POST(
    request({ name: "Deploy", scopes: ["monitors:read"] }, key)
  )
  const firstBody = await first.json()
  const second = await POST(
    request({ name: "Deploy", scopes: ["monitors:read"] }, key)
  )
  const secondBody = await second.json()
  return { first, firstBody, second, secondBody, key }
}

beforeEach(() => {
  idempotencyRecords.clear()
  vi.mocked(authorize).mockReset()
  vi.mocked(createApiToken).mockReset()
  vi.mocked(validateTokenInput).mockReset()
  process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters"
})

describe("CreatedToken persist/replay helpers", () => {
  const sample: CreatedTokenData = {
    id: "tok-1",
    name: "Deploy",
    scopes: ["monitors:read"],
    createdAt: "2026-07-18T12:00:00.000Z",
    expiresAt: "2026-10-16T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    token: "pulse_live_secret",
    expiryClamped: false,
  }

  it("omits only the secret and retains every other field", () => {
    const persisted = persistCreatedToken(sample)
    expect(persisted).toEqual({
      id: "tok-1",
      name: "Deploy",
      scopes: ["monitors:read"],
      createdAt: "2026-07-18T12:00:00.000Z",
      expiresAt: "2026-10-16T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      expiryClamped: false,
    })
    expect("token" in persisted).toBe(false)
  })

  it("retains future non-secret fields automatically via typed omit", () => {
    // Simulate a future response field that must round-trip without a field list.
    const extended = {
      ...sample,
      futureField: "keep-me",
    } as CreatedTokenData & { futureField: string }
    const persisted = persistCreatedToken(
      extended
    ) as PersistedCreatedTokenData & { futureField?: string }
    expect(persisted.futureField).toBe("keep-me")
    expect("token" in persisted).toBe(false)
    const replayed = replayCreatedToken(persisted, "pulse_live_replayed")
    expect(replayed).toEqual({
      ...persisted,
      token: "pulse_live_replayed",
    })
  })

  it("replays by spreading the stored body and attaching only the secret", () => {
    const persisted = persistCreatedToken({ ...sample, expiryClamped: true })
    const replayed = replayCreatedToken(persisted, "pulse_live_replayed")
    expect(replayed).toEqual({
      ...persisted,
      token: "pulse_live_replayed",
    })
    expect(replayed.expiryClamped).toBe(true)
  })
})

describe("POST /api/v1/tokens idempotency contract", () => {
  it("returns expiryClamped false on create and replay when unclamped", async () => {
    const { first, firstBody, second, secondBody } = await createAndReplay(
      humanContext,
      false
    )
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(firstBody.data.expiryClamped).toBe(false)
    expect(secondBody.data.expiryClamped).toBe(false)
    expect(firstBody.data).toEqual(secondBody.data)
    expect(createApiToken).toHaveBeenCalledTimes(1)
  })

  it("returns expiryClamped true on create and replay when clamped", async () => {
    const { first, firstBody, second, secondBody } = await createAndReplay(
      cliContext,
      true
    )
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(firstBody.data.expiryClamped).toBe(true)
    expect(secondBody.data.expiryClamped).toBe(true)
    expect(firstBody.data).toEqual(secondBody.data)
    expect(createApiToken).toHaveBeenCalledTimes(1)
  })

  it("stores a body without the secret and still reconstructs it on replay", async () => {
    const { firstBody, secondBody, key } = await createAndReplay(
      humanContext,
      false
    )
    const stored = idempotencyRecords.get(key)
    expect(stored?.body).toMatchObject({
      id: "tok-1",
      name: "Deploy",
      expiryClamped: false,
    })
    expect(stored?.body).not.toHaveProperty("token")
    expect(firstBody.data.token).toBe(
      "pulse_live_derived-secret-value-aaaaaaaaaaa"
    )
    expect(secondBody.data.token).toBe(
      "pulse_live_derived-secret-value-aaaaaaaaaaa"
    )
    expect(firstBody.data).toEqual(secondBody.data)
  })
})
