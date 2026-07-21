import { describe, expect, it, vi } from "vitest"

import {
  createDatabaseProbe,
  createEdgeConfigProbe,
  createEmailProbe,
} from "./probes"
import type { ReadinessProbeOptions } from "./types"

const env = {
  RESEND_API_KEY: "re_send_only",
  RESEND_FROM_EMAIL: "alerts@example.com",
}

const edgeEnv = {
  EDGE_CONFIG: "https://edge-config.vercel.com/ecfg_1?token=edge-token",
  EDGE_CONFIG_ID: "ecfg_1",
  VERCEL_API_TOKEN: "vercel-token",
}

function options(
  overrides: Partial<ReadinessProbeOptions> = {}
): ReadinessProbeOptions {
  return {
    deadlineAtMs: Date.now() + 9000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("email readiness probe", () => {
  it("verifies a send-only key through an idempotent Resend test delivery", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/domains")) {
          return jsonResponse({ message: "restricted" }, 403)
        }
        if (url.endsWith("/emails")) {
          expect(init?.method).toBe("POST")
          expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
            "pulse-readiness-example.com"
          )
          expect(JSON.parse(String(init?.body))).toMatchObject({
            from: "alerts@example.com",
            to: "delivered@resend.dev",
          })
          return jsonResponse({ id: "email_1" })
        }
        throw new Error(`unexpected ${url}`)
      }
    )

    const probe = createEmailProbe(env, fetcher)

    await expect(probe(options())).resolves.toMatchObject({
      state: "ready",
      code: "EMAIL_READY",
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("warns when a full-access key reports an unverified sender domain", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/domains")) {
        return jsonResponse({
          data: [{ name: "other.example.com", status: "verified" }],
          object: "list",
          has_more: false,
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const probe = createEmailProbe(env, fetcher)

    await expect(probe(options())).resolves.toMatchObject({
      state: "warning",
      code: "EMAIL_DOMAIN_UNVERIFIED",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("aborts email HTTP when the deadline signal fires", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false)
      controller.abort()
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    })

    const result = await createEmailProbe(
      env,
      fetcher
    )(
      options({
        deadlineAtMs: Date.now() + 5000,
        signal: controller.signal,
      })
    )

    expect(result).toMatchObject({
      state: "warning",
      code: "EMAIL_TIMEOUT",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeDefined()
  })
})

describe("edge readiness probe", () => {
  it("reads and writes over abortable fetch", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes("edge-config.vercel.com")) {
          expect(init?.signal).toBeDefined()
          return jsonResponse({ monitoring: { ok: true } })
        }
        if (url.includes("/v1/edge-config/ecfg_1/items")) {
          expect(init?.method).toBe("PATCH")
          expect(init?.signal).toBeDefined()
          expect(JSON.parse(String(init?.body))).toMatchObject({
            items: [
              {
                operation: "upsert",
                key: "readinessProbe",
                value: { ok: true },
              },
            ],
          })
          return jsonResponse({ ok: true })
        }
        throw new Error(`unexpected ${url}`)
      }
    )

    await expect(
      createEdgeConfigProbe(edgeEnv, fetcher)(options())
    ).resolves.toMatchObject({ state: "ready", code: "EDGE_READY" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("aborts Edge Config HTTP when the deadline signal fires", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.signal).toBeDefined()
      controller.abort()
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    })

    const result = await createEdgeConfigProbe(
      edgeEnv,
      fetcher
    )(
      options({
        deadlineAtMs: Date.now() + 5000,
        signal: controller.signal,
      })
    )

    expect(result).toMatchObject({
      state: "blocked",
      code: "EDGE_TIMEOUT",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe("database readiness probe", () => {
  it("surfaces timeout when the deadline is already spent", async () => {
    const probe = createDatabaseProbe(async () => {
      throw new Error("should not run")
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      probe(
        options({
          deadlineAtMs: Date.now() - 1,
          signal: controller.signal,
        })
      )
    ).resolves.toMatchObject({
      state: "blocked",
      code: "DATABASE_TIMEOUT",
    })
  })
})
