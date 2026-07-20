// Shared types for the Dependencies feature. Kept dependency-free so both the
// catalog manifest and the future adapters/poller can import from one place.

/** Adapter names, one per supported status-feed shape. */
export type DependencyAdapterName =
  | "statuspage_v2"
  | "incidentio_compat"
  | "google_cloud_status"
  | "statusio_public"
  | "sorry_v1";

/** Normalized Pulse-facing state. A failed feed must map to UNKNOWN, never OUTAGE. */
export type DependencyState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE" | "UNKNOWN";

/** Every adapter returns the same normalized value, per the source adapters contract. */
export type NormalizedProviderSnapshot = {
  sourceId: string;
  observedAt: string;
  providerUpdatedAt: string | null;
  /**
   * True when a successful fetch enumerates every component the provider
   * has, so a selector id absent from `components` means the component is
   * genuinely gone (resolves to UNKNOWN). Only google_cloud_status sets this
   * false: its feed only ever lists products with an active incident, so an
   * absent product legitimately means operational, not missing.
   */
  componentsComplete: boolean;
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
