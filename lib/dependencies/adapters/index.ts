// Common adapter interface plus the registry the poller (P3) resolves
// against. Every adapter here is pure: given already-fetched documents it
// returns a NormalizedProviderSnapshot, or throws AdapterParseError. No
// adapter performs network I/O; that stays in lib/dependencies/fetch.ts.

import type { DependencySourceManifest } from "../manifest";
import type { DependencyAdapterName, NormalizedProviderSnapshot } from "../types";

import { googleCloudStatusAdapter } from "./google-cloud-status";
import { incidentioCompatAdapter } from "./incidentio-compat";
import { AdapterParseError } from "./shared";
import { sorryV1Adapter } from "./sorry-v1";
import { statusioPublicAdapter } from "./statusio-public";
import { statuspageV2Adapter } from "./statuspage-v2";

export { AdapterParseError };
export type { AdapterParseErrorCode } from "./shared";

/** The three document roles a source's feed can play in a poll cycle. */
export type AdapterDocumentKind = "current" | "incidents" | "maintenance";

/** One document the poller must fetch. `optional` documents may be skipped by the poller's own staleness heuristics. */
export interface AdapterRequestDescriptor {
  kind: AdapterDocumentKind;
  url: string;
  optional?: boolean;
}

/** One document the poller already fetched this cycle, handed to normalize() as parsed JSON or raw text. */
export interface AdapterDocument {
  kind: AdapterDocumentKind;
  url: string;
  json?: unknown;
  text?: string;
}

export interface NormalizeInput {
  source: DependencySourceManifest;
  documents: AdapterDocument[];
  observedAt: string;
}

export interface DependencyAdapter {
  /**
   * Documents to fetch this cycle. Called again with the documents fetched
   * so far when an adapter needs a follow-up round (sorry_v1's component
   * pages and per-notice detail fetches); returns [] once nothing more is
   * needed.
   */
  requests(source: DependencySourceManifest, fetchedSoFar?: AdapterDocument[]): AdapterRequestDescriptor[];
  normalize(input: NormalizeInput): NormalizedProviderSnapshot;
}

export const adapterRegistry: Record<DependencyAdapterName, DependencyAdapter> = {
  statuspage_v2: statuspageV2Adapter,
  incidentio_compat: incidentioCompatAdapter,
  google_cloud_status: googleCloudStatusAdapter,
  statusio_public: statusioPublicAdapter,
  sorry_v1: sorryV1Adapter,
};
