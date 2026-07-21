// Shared translation between catalog sources, adapter request descriptors,
// and fetchProviderDocument. Poller and catalog revalidation both go through
// here so body caps, request mode, host allowlists, and deadline options stay
// identical for every dependency fetch path.

import type { AdapterRequestDescriptor } from "./adapters"
import {
  type FetchDocumentResult,
  type FetchProviderDocumentDeps,
  type FetchProviderSource,
  type FetchValidators,
  fetchProviderDocument,
} from "./fetch"

/** Minimum source fields needed to build a FetchProviderSource. */
export type ProviderSourceLike = {
  id: string
  allowedHosts: readonly string[]
  config?: Record<string, unknown>
}

/**
 * Optional per-request fetch knobs and the undici/DNS deps that
 * fetchProviderDocument accepts. Validators and deadline budgets are request
 * options, not part of the adapter descriptor.
 */
export type FetchAdapterRequestOptions = FetchProviderDocumentDeps & {
  validators?: FetchValidators
  timeoutMs?: number
  deadlineAtMs?: number
}

/** Reads a source's optional body-cap config. Fetch clamps the value into its valid range. */
function configuredMaxBodyBytes(
  config: Record<string, unknown> | undefined
): number | undefined {
  const value = config?.maxBodyBytes
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Builds the FetchProviderSource every dependency fetch path must use: source
 * id, catalog host allowlist, and the configured body cap when present.
 * maxBodyBytes is the type-checked config value; fetchProviderDocument still
 * clamps it into [DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES_CEILING].
 */
export function providerFetchSource(
  source: ProviderSourceLike
): FetchProviderSource {
  return {
    id: source.id,
    allowedHosts: source.allowedHosts,
    maxBodyBytes: configuredMaxBodyBytes(source.config),
  }
}

/**
 * Fetches one adapter request through fetchProviderDocument with the source's
 * allowlist and body policy. Forwards the adapter's URL and mode, labels the
 * error metadata with request.kind, and passes through validators plus any
 * caller timeout/deadline budget and fetch dependencies (shared dispatcher,
 * injected request, etc.).
 */
export async function fetchAdapterRequest(
  source: ProviderSourceLike,
  request: AdapterRequestDescriptor,
  options: FetchAdapterRequestOptions = {}
): Promise<FetchDocumentResult> {
  const { validators, timeoutMs, deadlineAtMs, ...fetchDeps } = options
  return fetchProviderDocument(
    providerFetchSource(source),
    {
      url: request.url,
      mode: request.mode,
      documentKind: request.kind,
      validators,
      timeoutMs,
      deadlineAtMs,
    },
    fetchDeps
  )
}
