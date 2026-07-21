import "server-only"

import { z } from "zod"

import {
  DependencyApiError,
  DependencyInstallConflictError,
} from "@/lib/dependencies/service"

import { apiError, errorEnvelope } from "./envelopes"
import type { StoredResponse } from "./idempotency"

/** Shared status map for the dependencies route family. */
export function dependencyErrorStatus(
  code: DependencyApiError["code"]
): number {
  if (code === "DEPENDENCY_NOT_FOUND") {
    return 404
  }
  if (code === "DEPENDENCY_EXISTS") {
    return 409
  }
  return 400
}

/** Shared HTTP mapping for the dependencies route family. */
export function dependencyError(
  error: unknown,
  requestId: string
): Response | null {
  if (error instanceof DependencyApiError) {
    return apiError(
      requestId,
      dependencyErrorStatus(error.code),
      error.code,
      error.message,
      error.details
    )
  }
  if (error instanceof z.ZodError) {
    return apiError(
      requestId,
      400,
      "INVALID_REQUEST",
      "Dependency request is invalid",
      { issues: error.issues }
    )
  }
  return null
}

// Turns a business error thrown inside the idempotency transaction into a
// stored response so the record commits that outcome instead of rolling back,
// mirroring the monitors route. A duplicate caught by the pre-check SELECT
// stores a clean 409 that a retry with the same key replays. A
// DependencyInstallConflictError means Postgres already aborted this same
// transaction reaching the unique index, so there is no live transaction left
// to store a completion into, and this returns null so the error rethrows,
// leaving the idempotency record running for a retry to redo the work.
export function storedDependencyError(
  error: unknown,
  requestId: string
): StoredResponse | null {
  if (error instanceof DependencyInstallConflictError) {
    return null
  }
  if (!(error instanceof DependencyApiError)) {
    return null
  }
  return {
    status: dependencyErrorStatus(error.code),
    body: errorEnvelope(error.code, error.message, requestId, error.details),
  }
}
