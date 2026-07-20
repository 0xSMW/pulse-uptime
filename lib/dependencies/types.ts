// Shared types for the Dependencies feature. Kept dependency-free so both the
// catalog manifest and the future adapters/poller can import from one place.

/**
 * Adapter names, one per supported status-feed shape. The first five have
 * built modules in adapters/. aws_health, nextdata_embedded, incident_feed,
 * and auth0_status are registered names their provider agents wire into the
 * registry when they land the module, so the union, the manifest enum, and
 * the DB check constraint all accept them ahead of the module existing.
 */
export type DependencyAdapterName =
  | "statuspage_v2"
  | "incidentio_compat"
  | "google_cloud_status"
  | "statusio_public"
  | "sorry_v1"
  | "aws_health"
  | "nextdata_embedded"
  | "incident_feed"
  | "auth0_status";

/** Normalized Pulse-facing state. A failed feed must map to UNKNOWN, never OUTAGE. */
export type DependencyState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE" | "UNKNOWN";

/**
 * Fidelity tier of a source or preset. "component" is the default: the feed
 * carries per-component operational state Pulse can normalize into a status
 * dot. "incident_only" marks a feed that publishes incident prose but no
 * structured current-component state (an RSS incident feed, an embedded SSR
 * payload without component health), so Pulse displays the provider's incident
 * text verbatim and never infers a component state from it.
 */
export type DependencyFidelity = "component" | "incident_only";

/**
 * Default streamed body cap for a status-feed document, 512 KB. A source may
 * raise its own cap up to MAX_BODY_BYTES_CEILING through its config, for feeds
 * that legitimately serve larger payloads (AWS's UTF-16 JSON runs large).
 * Kept here in the dependency-free types module so both the streaming fetch
 * and the manifest validator share one definition without either pulling in
 * the other's server-only imports.
 */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

/** Hard ceiling on any source's configured body cap, 4 MB. Manifest validation rejects a larger maxBodyBytes and the fetch clamps defensively. */
export const MAX_BODY_BYTES_CEILING = 4 * 1024 * 1024;

/** Every adapter returns the same normalized value, per the source adapters contract. */
export type NormalizedProviderSnapshot = {
  sourceId: string;
  observedAt: string;
  providerUpdatedAt: string | null;
  /**
   * True when a successful fetch enumerates every component the provider
   * has, so a selector id absent from `components` means the component is
   * genuinely gone (resolves to UNKNOWN). Set false by google_cloud_status and
   * aws_health, both active-only feeds that list only products with an active
   * incident, so an absent component legitimately means operational, not missing.
   */
  componentsComplete: boolean;
  /**
   * True when a successful fetch authoritatively enumerates every open
   * incident for the source, so a stored-open incident absent from
   * `incidents` has genuinely gone away and may be closed (resolved_at set to
   * observedAt). Set false by any adapter whose feed is a rolling window that
   * could transiently omit a still-open incident, so absence is never read as
   * resolution. See persistSnapshot's completeness-gated closure.
   */
  incidentsComplete: boolean;
  components: Record<string, {
    state: "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";
    updatedAt: string | null;
  }>;
  incidents: Array<{
    externalId: string;
    title: string;
    state: string;
    impact: string | null;
    startedAt: string;
    resolvedAt: string | null;
    updatedAt: string;
    canonicalUrl: string | null;
    componentIds: string[];
    updates: Array<{
      externalId: string;
      state: string;
      bodyText: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
  maintenances: Array<{
    externalId: string;
    state: string;
    startsAt: string;
    endsAt: string | null;
    componentIds: string[];
  }>;
  cache: { etag: string | null; lastModified: string | null };
};

/**
 * Selector kinds. A selector containing multiple component IDs aggregates
 * with worst_of: OUTAGE, DEGRADED, MAINTENANCE, then OPERATIONAL.
 */
export type ComponentIdsSelector = {
  kind: "component_ids";
  aggregation: "worst_of";
  ids: string[];
};

/** Google Cloud matches on affected_products[].id, with an optional location filter. */
export type GoogleProductSelector = {
  kind: "google_product";
  productId: string;
  location?: { required: boolean };
};

/** Status.io matches a component by result.status[].id and a region by containers[].id. */
export type StatusioComponentContainerSelector = {
  kind: "statusio_component_container";
  componentId: string;
  container: { required: boolean };
};

export type DependencySelector =
  | ComponentIdsSelector
  | GoogleProductSelector
  | StatusioComponentContainerSelector;

/** A fixed, catalog-validated scope choice (e.g. one Neon region container). */
export type ScopeOption = { id: string; label: string };

/**
 * Scope requirements for presets with unavoidable regional or grouped scope.
 * `required_options` ships a static validated list in the catalog (Neon
 * region containers). `discovered_children` validates children of a known
 * upstream group at catalog-validation time (Supabase compute regions,
 * Upstash regional group). `discovered_locations` is Google's optional
 * location filter, sourced from the product's affected-locations data.
 */
export type DependencyScope =
  | { kind: "required_options"; options: ScopeOption[] }
  | { kind: "discovered_children"; groupId: string; required: boolean }
  | { kind: "discovered_locations"; required: boolean };
