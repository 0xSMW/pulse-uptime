import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const { fetchProviderDocument } = vi.hoisted(() => ({
  fetchProviderDocument: vi.fn(),
}))
vi.mock("./fetch", () => ({ fetchProviderDocument }))

import { fetchAdapterRequest, providerFetchSource } from "./source-fetch"

beforeEach(() => {
  fetchProviderDocument.mockReset()
  fetchProviderDocument.mockResolvedValue({
    status: "ok",
    statusCode: 200,
    json: {},
    etag: null,
    lastModified: null,
  })
})

describe("providerFetchSource", () => {
  it("forwards id and allowedHosts and omits maxBodyBytes when config has none", () => {
    expect(
      providerFetchSource({
        id: "anthropic",
        allowedHosts: ["status.claude.com"],
        config: {},
      })
    ).toEqual({
      id: "anthropic",
      allowedHosts: ["status.claude.com"],
      maxBodyBytes: undefined,
    })
  })

  it("reads a finite maxBodyBytes from source config", () => {
    expect(
      providerFetchSource({
        id: "aws",
        allowedHosts: ["health.aws.amazon.com"],
        config: { maxBodyBytes: 2 * 1024 * 1024 },
      })
    ).toEqual({
      id: "aws",
      allowedHosts: ["health.aws.amazon.com"],
      maxBodyBytes: 2 * 1024 * 1024,
    })
  })

  it("ignores a non-numeric maxBodyBytes config value", () => {
    expect(
      providerFetchSource({
        id: "broken",
        allowedHosts: ["example.com"],
        config: { maxBodyBytes: "big" },
      }).maxBodyBytes
    ).toBeUndefined()
  })
})

describe("fetchAdapterRequest", () => {
  const source = {
    id: "auth0",
    allowedHosts: ["status.auth0.com"],
    config: { maxBodyBytes: 2 * 1024 * 1024 },
  }

  it("builds the provider source and forwards URL, mode, and documentKind", async () => {
    await fetchAdapterRequest(source, {
      kind: "current",
      url: "https://status.auth0.com/",
      mode: "text",
      optional: false,
    })

    expect(fetchProviderDocument).toHaveBeenCalledTimes(1)
    const [providerSource, request] = fetchProviderDocument.mock.calls[0]!
    expect(providerSource).toEqual({
      id: "auth0",
      allowedHosts: ["status.auth0.com"],
      maxBodyBytes: 2 * 1024 * 1024,
    })
    expect(request).toMatchObject({
      url: "https://status.auth0.com/",
      mode: "text",
      documentKind: "current",
    })
  })

  it("passes validators, deadline options, and fetch deps through", async () => {
    const dispatcher = { close: vi.fn() }
    const requestFn = vi.fn()
    await fetchAdapterRequest(
      source,
      { kind: "incidents", url: "https://status.auth0.com/incidents.json" },
      {
        validators: {
          etag: '"v1"',
          lastModified: "Mon, 20 Jul 2026 00:00:00 GMT",
        },
        timeoutMs: 1500,
        deadlineAtMs: 1_000_000,
        dispatcher: dispatcher as never,
        request: requestFn,
      }
    )

    const [, request, deps] = fetchProviderDocument.mock.calls[0]!
    expect(request).toMatchObject({
      url: "https://status.auth0.com/incidents.json",
      documentKind: "incidents",
      validators: {
        etag: '"v1"',
        lastModified: "Mon, 20 Jul 2026 00:00:00 GMT",
      },
      timeoutMs: 1500,
      deadlineAtMs: 1_000_000,
    })
    expect(deps).toMatchObject({ dispatcher, request: requestFn })
    // Options that are request knobs must not leak into the undici deps bag.
    expect(deps).not.toHaveProperty("validators")
    expect(deps).not.toHaveProperty("timeoutMs")
    expect(deps).not.toHaveProperty("deadlineAtMs")
  })
})
