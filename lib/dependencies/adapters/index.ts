// Common adapter interface plus the registry the poller (P3) resolves
// against. Every adapter here is pure: given already-fetched documents it
// returns a NormalizedProviderSnapshot, or throws AdapterParseError. No
// adapter performs network I/O; that stays in lib/dependencies/fetch.ts.

import type { DependencySourceManifest } from "../manifest";
import type {
  CatalogComponentDirectory,
  DependencyAdapterName,
  NormalizedProviderSnapshot,
} from "../types";

import { auth0StatusAdapter } from "./auth0-status";
import { awsHealthAdapter } from "./aws-health";
import { googleCloudStatusAdapter } from "./google-cloud-status";
import { incidentFeedAdapter } from "./incident-feed";
import { incidentioCompatAdapter } from "./incidentio-compat";
import { nextdataEmbeddedAdapter } from "./nextdata-embedded";
import { AdapterParseError, catalogDirectoryFromNormalize } from "./shared";
import { sorryV1Adapter } from "./sorry-v1";
import { statusioPublicAdapter } from "./statusio-public";
import { statuspageV2Adapter } from "./statuspage-v2";

export { AdapterParseError, catalogDirectoryFromNormalize };
export type { AdapterParseErrorCode } from "./shared";

/** The three document roles a source's feed can play in a poll cycle. */
export type AdapterDocumentKind = "current" | "incidents" | "maintenance";

/** One document the poller must fetch. `optional` documents may be skipped by the poller's own staleness heuristics. */
export interface AdapterRequestDescriptor {
  kind: AdapterDocumentKind;
  url: string;
  optional?: boolean;
  /**
   * Fetch mode forwarded to fetchProviderDocument. "json" (the default when
   * omitted) parses the body as JSON. "text" returns the decoded body verbatim
   * for feeds that are not JSON, such as an SSR HTML page with an embedded
   * __NEXT_DATA__ payload. Both modes apply the identical security controls.
   */
  mode?: "json" | "text";
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

export interface CatalogDirectoryInput {
  source: DependencySourceManifest;
  documents: AdapterDocument[];
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
  /**
   * Builds the catalog component directory from already-fetched current
   * documents. complete is true only when the adapter could parse the full
   * set it needs for identity and group/location discovery. Callers must
   * only invoke this after document collection finished complete.
   */
  catalogDirectory(input: CatalogDirectoryInput): CatalogComponentDirectory;
}

/**
 * Adapter modules keyed by adapter name. Partial on purpose: the
 * DependencyAdapterName union also carries names whose modules are owned by
 * separate provider agents (aws_health, nextdata_embedded, incident_feed,
 * auth0_status). Each agent adds its entry here when it lands its module, so
 * this registry never has to reference a module that does not yet exist.
 * Resolve through resolveAdapter, which turns an unregistered name into a
 * clear error rather than an undefined dereference. No catalog source may name
 * an adapter that is absent here, guarded by adapters/index.test.ts against
 * the shipped manifest.
 */
export const adapterRegistry: Partial<Record<DependencyAdapterName, DependencyAdapter>> = {
  aws_health: awsHealthAdapter,
  statuspage_v2: statuspageV2Adapter,
  incidentio_compat: incidentioCompatAdapter,
  google_cloud_status: googleCloudStatusAdapter,
  statusio_public: statusioPublicAdapter,
  sorry_v1: sorryV1Adapter,
  incident_feed: incidentFeedAdapter,
  auth0_status: auth0StatusAdapter,
  nextdata_embedded: nextdataEmbeddedAdapter,
};

/** Resolves an adapter by name, throwing when no module is registered for it yet. Callers always have a source that named the adapter, so absence is a catalog or wiring error, not a runtime input error. */
export function resolveAdapter(name: DependencyAdapterName): DependencyAdapter {
  const adapter = adapterRegistry[name];
  if (!adapter) throw new Error(`No dependency adapter registered for "${name}"`);
  return adapter;
}
