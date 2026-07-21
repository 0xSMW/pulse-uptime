import { describe, expect, it } from "vitest"

import { isDatabaseUnavailableError } from "./errors"

function errorWithCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

describe("isDatabaseUnavailableError", () => {
  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"],
    ["ECONNRESET", "read ECONNRESET"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND db.internal"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN db.internal"],
    ["ETIMEDOUT", "connect ETIMEDOUT"],
  ])("classifies raw network error code %s as unavailable", (code, message) => {
    expect(isDatabaseUnavailableError(errorWithCode(code, message))).toBe(true)
  })

  it.each([
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECTION_ENDED",
  ])(
    "classifies postgres.js connection error code %s as unavailable",
    (code) => {
      expect(
        isDatabaseUnavailableError(
          errorWithCode(code, `write ${code} 127.0.0.1:5432`)
        )
      ).toBe(true)
    }
  )

  it("classifies an unrecognized postgres.js CONNECTION_ prefixed code as unavailable", () => {
    expect(
      isDatabaseUnavailableError(
        errorWithCode("CONNECTION_SOME_FUTURE_VARIANT")
      )
    ).toBe(true)
  })

  it.each([
    ["28P01", "invalid_password"],
    ["28000", "invalid_authorization_specification"],
    ["42P01", "undefined_table"],
    ["42703", "undefined_column"],
  ])("classifies Postgres SQLSTATE %s (%s) as unavailable", (code) => {
    expect(
      isDatabaseUnavailableError(errorWithCode(code, "postgres error"))
    ).toBe(true)
  })

  it("walks the cause chain to find an unavailable-classified error", () => {
    const root = errorWithCode("ECONNREFUSED")
    const wrapped = new Error("query failed", { cause: root })
    const doubleWrapped = new Error("outer failure", { cause: wrapped })
    expect(isDatabaseUnavailableError(doubleWrapped)).toBe(true)
  })

  it("checks AggregateError.errors entries (Node happy-eyeballs dual-stack failures)", () => {
    const aggregate = new AggregateError(
      [errorWithCode("ECONNREFUSED"), errorWithCode("ECONNREFUSED")],
      "connect failed"
    )
    expect(isDatabaseUnavailableError(aggregate)).toBe(true)
  })

  it("rethrows (returns false) for a plain app error", () => {
    expect(
      isDatabaseUnavailableError(
        new TypeError("Cannot read properties of undefined")
      )
    ).toBe(false)
  })

  it("rethrows (returns false) for a Postgres constraint violation", () => {
    expect(
      isDatabaseUnavailableError(
        errorWithCode("23505", "duplicate key value violates unique constraint")
      )
    ).toBe(false)
  })

  it("rethrows (returns false) for a Postgres syntax error", () => {
    expect(
      isDatabaseUnavailableError(
        errorWithCode("42601", "syntax error at or near")
      )
    ).toBe(false)
  })

  it("does not classify an unrelated error even when its cause chain has no code", () => {
    const inner = new Error("some app bug")
    const outer = new Error("wrapped", { cause: inner })
    expect(isDatabaseUnavailableError(outer)).toBe(false)
  })

  it("returns false for non-object / nullish input", () => {
    expect(isDatabaseUnavailableError(null)).toBe(false)
    expect(isDatabaseUnavailableError(undefined)).toBe(false)
    expect(isDatabaseUnavailableError("some string")).toBe(false)
    expect(isDatabaseUnavailableError(42)).toBe(false)
  })

  it("does not infinite-loop on a circular cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a")
    const b: Error & { cause?: unknown } = new Error("b")
    a.cause = b
    b.cause = a
    expect(isDatabaseUnavailableError(a)).toBe(false)
  })
})
