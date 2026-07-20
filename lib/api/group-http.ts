import "server-only";

import { z } from "zod";

import { ConfigSizeError } from "@/lib/config";

import { ConfigMutationError } from "./config-mutation";
import { apiError, errorEnvelope } from "./envelopes";
import { GroupApiError } from "./groups";
import { type StoredResponse } from "./idempotency";

/**
 * Shared status map for the groups route family. GROUP_NOT_FOUND is a missing
 * target (404), GROUP_EXISTS and GROUP_NOT_EMPTY are conflicts with current
 * config state (409).
 */
export function groupErrorStatus(code: GroupApiError["code"]): number {
  return code === "GROUP_NOT_FOUND" ? 404 : 409;
}

/** Shared HTTP mapping for the groups route family. */
export function groupError(error: unknown, requestId: string): Response | null {
  if (error instanceof GroupApiError) return apiError(requestId, groupErrorStatus(error.code), error.code, error.message, error.details);
  if (error instanceof ConfigMutationError) return apiError(requestId, 503, error.code, error.message);
  if (error instanceof ConfigSizeError) return apiError(requestId, 400, error.code, error.message, { actualBytes: error.actualBytes, maximumBytes: error.maximumBytes });
  if (error instanceof z.ZodError) return apiError(requestId, 400, "INVALID_REQUEST", "Group request is invalid", { issues: error.issues });
  return null;
}

// A GroupApiError from addGroup/renameGroup/removeGroup is a real outcome of
// current config state, not evidence the mutation never ran: each validates
// and throws before nextConfig produces a new config, so the completion can
// commit alongside this stored error instead of leaving the record running for
// a stale-window retry to rerun against whatever state exists by then.
export function storedGroupError(error: GroupApiError, requestId: string): StoredResponse {
  return { status: groupErrorStatus(error.code), body: errorEnvelope(error.code, error.message, requestId, error.details) };
}
