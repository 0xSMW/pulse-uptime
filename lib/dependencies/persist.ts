import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import {
  dependencies,
  dependencyCatalog,
  dependencyIncidentMatches,
  dependencySources,
  dependencyState,
  dependencyStateIntervals,
  providerIncidentComponents,
  providerIncidentUpdates,
  providerIncidents,
} from "@/lib/db/schema";
import { enqueueDependencyNotifications } from "@/lib/notifications/enqueue";

import type { PollOutcome } from "./poller";
import type { DependencyAdapterName, DependencySelector, DependencyState, NormalizedProviderSnapshot } from "./types";

// One transaction per source: upsert provider incidents and their updates
// and components, recompute every installed dependency's state from its
// catalog selector, close/open state intervals only on change, write
// dependency_incident_matches, enqueue the notification outbox, and update
// source health. Every write here is either idempotent (ON CONFLICT DO
// NOTHING) or conditional-on-change, so repeated polls of unchanged upstream
// data append nothing: the concurrency and idempotency tests lean on this.

type ComponentishState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";
type NormalizedIncident = NormalizedProviderSnapshot["incidents"][number];

const STATE_RANK: Record<ComponentishState, number> = { OPERATIONAL: 0, MAINTENANCE: 1, DEGRADED: 2, OUTAGE: 3 };
const BACKOFF_MINUTES = [5, 15, 30];

export function worstOf(states: readonly ComponentishState[]): ComponentishState {
  if (states.length === 0) return "OPERATIONAL";
  return states.reduce((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst));
}

/**
 * Component states with active maintenance windows folded in. A component
 * with no active incident and no active maintenance defaults to
 * OPERATIONAL; maintenance only raises a component that would otherwise be
 * OPERATIONAL, it never masks a worse reported state.
 */
export function combinedComponentStates(snapshot: NormalizedProviderSnapshot): Map<string, ComponentishState> {
  const map = new Map<string, ComponentishState>();
  for (const [id, component] of Object.entries(snapshot.components)) map.set(id, component.state);

  const observedAt = new Date(snapshot.observedAt);
  for (const maintenance of snapshot.maintenances) {
    if (maintenance.state === "completed") continue;
    const startsAt = new Date(maintenance.startsAt);
    const endsAt = maintenance.endsAt ? new Date(maintenance.endsAt) : null;
    if (startsAt > observedAt || (endsAt && endsAt < observedAt)) continue;
    for (const componentId of maintenance.componentIds) {
      const existing = map.get(componentId);
      if (!existing || STATE_RANK.MAINTENANCE > STATE_RANK[existing]) map.set(componentId, "MAINTENANCE");
    }
  }
  return map;
}

/**
 * The upstream ids that identify this dependency for both state lookup and
 * incident-component intersection. Google's location-scoped composite
 * (productId@locationId) only ever appears in incident.componentIds, never
 * in the components state map (see google-cloud-status.ts), so it is
 * folded in here purely for matching, not for combinedComponentStates
 * lookups.
 */
export function matchingIdsForSelector(selector: DependencySelector, scopeId: string | null): string[] {
  switch (selector.kind) {
    case "component_ids":
      return scopeId ? [...selector.ids, scopeId] : [...selector.ids];
    case "statusio_component_container":
      return scopeId ? [selector.componentId, scopeId] : [selector.componentId];
    case "google_product":
      return scopeId ? [selector.productId, `${selector.productId}@${scopeId}`] : [selector.productId];
  }
}

/**
 * Resolves one dependency's state from its selector. Google's location
 * scope is the one case that can't use combinedComponentStates directly:
 * the adapter never stores a per-location component state, only a
 * per-location composite id on incidents (see google-cloud-status.ts), so a
 * scoped Google product's severity is approximated from the product's bare
 * aggregate state, gated on whether an active incident actually names this
 * location. This is a documented approximation, not a precise per-location
 * severity, since the normalized snapshot has no other way to carry it.
 *
 * A selector id absent from `combined` means UNKNOWN when the snapshot's
 * componentsComplete flag is true (the feed enumerated every component and
 * simply doesn't have this one anymore), otherwise OPERATIONAL (only
 * google_cloud_status sets componentsComplete false, since its feed only
 * ever lists products with an active incident). worst_of still applies
 * across every id that IS present; an absent id under a complete feed short
 * circuits the whole dependency to UNKNOWN.
 */
export function resolveDependencyState(
  selector: DependencySelector,
  scopeId: string | null,
  combined: ReadonlyMap<string, ComponentishState>,
  snapshot: NormalizedProviderSnapshot,
): DependencyState {
  const fallback = (): DependencyState => (snapshot.componentsComplete ? "UNKNOWN" : "OPERATIONAL");

  if (selector.kind === "google_product" && scopeId) {
    const compositeKey = `${selector.productId}@${scopeId}`;
    const touchedByActiveIncident = snapshot.incidents.some(
      (incident) => incident.resolvedAt === null && incident.componentIds.includes(compositeKey),
    );
    if (!touchedByActiveIncident) return "OPERATIONAL";
    return combined.get(selector.productId) ?? fallback();
  }

  const ids = matchingIdsForSelector(selector, scopeId);
  const states: ComponentishState[] = [];
  for (const id of ids) {
    const state = combined.get(id);
    if (state) {
      states.push(state);
      continue;
    }
    if (snapshot.componentsComplete) return "UNKNOWN";
    states.push("OPERATIONAL");
  }
  return worstOf(states);
}

/** incidentio_compat incidents never carry an explicit component list (see incidentio-compat.ts); every other launch adapter's componentIds are explicit provider data. */
export function associationKindForAdapter(adapter: DependencyAdapterName): "explicit" | "inferred" {
  return adapter === "incidentio_compat" ? "inferred" : "explicit";
}

export function selectorIntersectsIncident(selector: DependencySelector, scopeId: string | null, incidentComponentIds: readonly string[]): boolean {
  const ids = new Set(matchingIdsForSelector(selector, scopeId));
  return incidentComponentIds.some((id) => ids.has(id));
}

/**
 * Notification events are derived from the incident's observed state
 * TRANSITION, not from match-row newness alone. `priorResolvedAt` is the
 * incident's resolved_at as stored before this poll's upserts touch it:
 * `undefined` means the incident row did not exist yet (never observed by
 * this source before this poll), `null` means it existed and was open, and a
 * Date means it existed and was already resolved.
 *
 * "incident" fires whenever the incident is observed active (resolved_at
 * null) and this poll is a transition into a matched-active state, which is
 * true in exactly two ways regardless of whether the match row is new or
 * old. Either the dependency is matched to an incident that was open, or new
 * this poll, and not already known-resolved (a fresh active match), or the
 * incident was stored resolved as of the prior poll and is now active again
 * (a reopen). A reopen fires whether the match row already existed from an
 * earlier cycle or was first created against the reopened incident on this
 * poll. The one active case that fires nothing is an unchanged still-open
 * match: the incident was already open as of the prior poll (priorResolvedAt
 * null) and the match row is not new, so no transition happened. A match
 * created against an already-resolved incident (isActive false: a historical
 * incident found on install, or one that opened and closed within a single
 * poll gap) is backfill, not a transition, and never fires "incident".
 *
 * "recovery" fires only on the poll where the incident is observed resolved
 * for the first time: the incident must have existed before this poll with
 * resolved_at still null. An incident that was already resolved as of the
 * prior poll never fires recovery again, regardless of whether a match row
 * for this dependency is new or old, and regardless of the outbox's own
 * idempotency keys. A later reopen-then-resolve cycle for the same external
 * id fires recovery again the same way, since at that poll resolved_at is
 * again observed transitioning from open (null) to resolved.
 */
export function deriveNotificationEvent(
  isNewMatch: boolean,
  isActive: boolean,
  priorResolvedAt: Date | null | undefined,
): "incident" | "recovery" | null {
  const priorKnownResolved = priorResolvedAt !== undefined && priorResolvedAt !== null;
  if (isActive) return isNewMatch || priorKnownResolved ? "incident" : null;
  if (priorResolvedAt === null) return "recovery";
  return null;
}

/**
 * The external id value threaded into a notification's idempotency key
 * (dependencyNotificationKey), kept separate from the incident's own
 * external id used for storage and matching. A first-time "incident" event
 * (isReopen false) carries the bare external id unchanged, so an
 * already-enqueued row for it keeps deduplicating exactly as before. A
 * reopen "incident" event (isReopen true: the incident was stored resolved
 * as of the prior poll and is now active again, whether the match row is new
 * this poll or predates the resolution) appends the timestamp of the
 * resolution the reopen transitioned away from, since that timestamp is
 * stable across polls and retries of the same reopen. A "recovery" event
 * always appends the resolvedAt timestamp reported for that resolution, so
 * a later reopen-then-resolve cycle's recovery mints a key distinct from an
 * earlier cycle's recovery instead of colliding with it.
 */
export function notificationKeyExternalId(
  event: "incident" | "recovery",
  incidentExternalId: string,
  isReopen: boolean,
  priorResolvedAt: Date | null | undefined,
  resolvedAt: string | null,
): string {
  if (event === "incident") {
    return isReopen && priorResolvedAt ? `${incidentExternalId}#${priorResolvedAt.getTime()}` : incidentExternalId;
  }
  return resolvedAt ? `${incidentExternalId}#${new Date(resolvedAt).getTime()}` : incidentExternalId;
}

/** Retry-After wins outright when the provider sent one; otherwise the fixed 5/15/30 minute ladder, indexed by how many consecutive failures this is. */
export function failureDelayMs(consecutiveFailures: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.max(0, retryAfterMs);
  const index = Math.min(Math.max(consecutiveFailures - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index] * 60_000;
}

export function isSourceStale(lastSuccessAt: Date | null, staleAfterSeconds: number, now: Date): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() > staleAfterSeconds * 1000;
}

export function computeNextPollAt(allOperational: boolean, source: { operationalPollSeconds: number; activePollSeconds: number }, now: Date): Date {
  return new Date(now.getTime() + (allOperational ? source.operationalPollSeconds : source.activePollSeconds) * 1000);
}

// -- Executor interface -------------------------------------------------

export interface PersistSourceRow {
  id: string;
  provider: string;
  adapter: DependencyAdapterName;
  statusPageUrl: string;
  allowedHosts: readonly string[];
  operationalPollSeconds: number;
  activePollSeconds: number;
  staleAfterSeconds: number;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
}

/**
 * Only ever returns a provider-supplied URL when it parses as https and its
 * host is allowlisted for the source (or is the source's own status page
 * host); otherwise falls back to the source's status page. Applied before a
 * canonical URL is written to provider_incidents or put in a notification
 * payload, so neither the dashboard nor an email ever renders an
 * unvalidated href, e.g. a javascript: URL or an attacker-controlled host.
 */
export function safeProviderUrl(rawUrl: string | null, source: { statusPageUrl: string; allowedHosts: readonly string[] }): string {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:") {
        const statusHost = new URL(source.statusPageUrl).hostname;
        if (parsed.hostname === statusHost || source.allowedHosts.includes(parsed.hostname)) {
          return rawUrl;
        }
      }
    } catch {
      // Falls through to the status page below.
    }
  }
  return source.statusPageUrl;
}

export interface InstalledDependencyRow {
  id: string;
  catalogId: string;
  presetName: string;
  scopeId: string | null;
  selector: DependencySelector;
  notificationsEnabled: boolean;
  currentState: DependencyState;
}

export interface DependencyNotificationInput {
  event: "incident" | "recovery";
  sourceId: string;
  dependencyId: string;
  presetId: string;
  scopeId: string | null;
  dependencyName: string;
  provider: string;
  /** The idempotency-key external id (see notificationKeyExternalId), not necessarily the incident's bare external id. */
  incidentExternalId: string;
  incidentTitle: string;
  state: string;
  canonicalUrl: string | null;
  providerTimestamp: string;
  recipients: readonly string[];
}

export interface PersistExecutor {
  loadInstalledDependencies(sourceId: string): Promise<InstalledDependencyRow[]>;
  /**
   * Batched read of resolved_at for this source's incidents, keyed by
   * external id, as stored before this poll's upserts touch them. Read once
   * up front so the event-transition check below compares against a stable
   * prior state rather than the row this same poll just wrote. A missing key
   * means the incident row did not exist before this poll.
   */
  loadPriorIncidentResolution(sourceId: string, externalIds: readonly string[]): Promise<Map<string, Date | null>>;
  /**
   * Existing (dependencyId, incidentId) pairs already recorded in
   * dependency_incident_matches for these incident internal ids, as a
   * `${dependencyId}:${incidentId}` key set. This is the fallback for an
   * incident with no componentIds of its own (incidentio_compat's resolved
   * incidents, see incidentio-compat.ts): with nothing to intersect a
   * selector against, a dependency is only still considered matched if it
   * already has a match row from while the incident carried components.
   */
  loadExistingMatches(incidentIds: readonly string[]): Promise<Set<string>>;
  /** Upsert on (source_id, external_id); updates in place only when provider_updated_at actually advanced. Returns the incident's internal id either way. */
  upsertIncident(sourceId: string, candidateId: string, incident: NormalizedIncident): Promise<string>;
  /** New (incidentId, externalComponentId) pairs only; existing pairs are left untouched. */
  upsertIncidentComponents(incidentId: string, componentIds: readonly string[], associationKind: "explicit" | "inferred"): Promise<void>;
  /** New (incidentId, externalUpdateId) pairs only; provider updates are immutable once posted. */
  upsertIncidentUpdates(incidentId: string, updates: NormalizedIncident["updates"]): Promise<void>;
  /**
   * New (dependencyId, incidentId) pairs only; a match, once recorded, is
   * never removed even if the provider later disassociates the component.
   * Returns true only when this call newly inserted the row (INSERT ...
   * ON CONFLICT DO NOTHING RETURNING), false when the pair already existed:
   * combined with the incident's prior resolved_at, this tells "just started
   * matching" apart from "still matching, same as last poll".
   */
  upsertDependencyIncidentMatch(dependencyId: string, incidentId: string, matchKind: "component_match" | "inferred", now: Date): Promise<boolean>;
  /** Updates dependency_state in place always; closes/opens dependency_state_intervals only when state changed from previousState. */
  applyDependencyState(dependencyId: string, previousState: DependencyState, next: { state: DependencyState; observedAt: Date; providerUpdatedAt: Date | null }, now: Date): Promise<void>;
  enqueueNotification(input: DependencyNotificationInput, now: Date): Promise<number>;
  updateSourceHealthSuccess(sourceId: string, patch: { etag: string | null; lastModified: string | null; nextPollAt: Date; now: Date }): Promise<void>;
  updateSourceHealthNotModified(sourceId: string, patch: { etag: string | null; lastModified: string | null; nextPollAt: Date; now: Date }): Promise<void>;
  updateSourceHealthFailure(sourceId: string, patch: { errorCode: string; consecutiveFailures: number; nextPollAt: Date; now: Date }): Promise<void>;
}

export interface PersistStore {
  transaction<T>(work: (tx: PersistExecutor) => Promise<T>): Promise<T>;
}

export interface PersistContext {
  now: Date;
  defaultRecipients: readonly string[];
}

export interface PersistSummary {
  dependenciesEvaluated: number;
  incidentsUpserted: number;
  notificationsEnqueued: number;
  flippedToUnknown: number;
}

const EMPTY_SUMMARY: PersistSummary = { dependenciesEvaluated: 0, incidentsUpserted: 0, notificationsEnqueued: 0, flippedToUnknown: 0 };

async function applyAllOperationalNextPoll(
  tx: PersistExecutor,
  source: PersistSourceRow,
  states: ReadonlyMap<string, DependencyState>,
  outcomeCache: { etag: string | null; lastModified: string | null },
  now: Date,
  kind: "snapshot" | "not_modified",
): Promise<void> {
  const allOperational = [...states.values()].every((state) => state === "OPERATIONAL");
  const nextPollAt = computeNextPollAt(allOperational, source, now);
  const patch = { etag: outcomeCache.etag, lastModified: outcomeCache.lastModified, nextPollAt, now };
  if (kind === "snapshot") await tx.updateSourceHealthSuccess(source.id, patch);
  else await tx.updateSourceHealthNotModified(source.id, patch);
}

export async function persistSnapshot(
  store: PersistStore,
  outcome: PollOutcome,
  source: PersistSourceRow,
  context: PersistContext,
): Promise<PersistSummary> {
  return store.transaction(async (tx) => {
    if (outcome.kind === "not_modified") {
      const installed = await tx.loadInstalledDependencies(source.id);
      const states = new Map(installed.map((dependency) => [dependency.id, dependency.currentState] as const));
      await applyAllOperationalNextPoll(tx, source, states, outcome, context.now, "not_modified");
      return EMPTY_SUMMARY;
    }

    if (outcome.kind === "failure") {
      const consecutiveFailures = source.consecutiveFailures + 1;
      const nextPollAt = new Date(context.now.getTime() + failureDelayMs(consecutiveFailures, outcome.retryAfterMs));
      const errorCode = errorCodeOf(outcome.error);
      await tx.updateSourceHealthFailure(source.id, { errorCode, consecutiveFailures, nextPollAt, now: context.now });

      let flippedToUnknown = 0;
      if (isSourceStale(source.lastSuccessAt, source.staleAfterSeconds, context.now)) {
        const installed = await tx.loadInstalledDependencies(source.id);
        for (const dependency of installed) {
          if (dependency.currentState === "UNKNOWN") continue;
          await tx.applyDependencyState(dependency.id, dependency.currentState, {
            state: "UNKNOWN",
            observedAt: context.now,
            providerUpdatedAt: null,
          }, context.now);
          flippedToUnknown += 1;
        }
      }
      return { ...EMPTY_SUMMARY, flippedToUnknown };
    }

    // outcome.kind === "snapshot"
    const { snapshot } = outcome;
    const combined = combinedComponentStates(snapshot);
    const associationKind = associationKindForAdapter(source.adapter);

    // Sanitize every incident's canonicalUrl once, up front: the same safe
    // value is what gets persisted to provider_incidents and what travels
    // into a notification payload, so neither the dashboard nor an email
    // ever renders an unvalidated provider-supplied href.
    const incidents = snapshot.incidents.map((incident) => ({
      ...incident,
      canonicalUrl: safeProviderUrl(incident.canonicalUrl, source),
    }));

    // Read every one of this poll's incidents' prior resolved_at before any
    // upsert below overwrites it, so the transition check further down
    // compares against the state as of the last poll, not this one.
    const priorIncidentResolution = await tx.loadPriorIncidentResolution(source.id, incidents.map((incident) => incident.externalId));

    let incidentsUpserted = 0;
    const incidentInternalIds = new Map<string, string>();
    for (const incident of incidents) {
      const internalId = await tx.upsertIncident(source.id, randomUUID(), incident);
      incidentInternalIds.set(incident.externalId, internalId);
      await tx.upsertIncidentComponents(internalId, incident.componentIds, associationKind);
      await tx.upsertIncidentUpdates(internalId, incident.updates);
      incidentsUpserted += 1;
    }

    // A dependency selector has nothing to intersect against an incident
    // whose componentIds are empty (incidentio_compat's resolved incidents
    // never carry any, see incidentio-compat.ts), so those incidents fall
    // back to whatever match rows already exist from while they still had
    // components. One batched read up front covers every such incident in
    // this snapshot.
    const emptyComponentIncidentIds = incidents
      .filter((incident) => incident.componentIds.length === 0)
      .map((incident) => incidentInternalIds.get(incident.externalId))
      .filter((id): id is string => id !== undefined);
    const existingMatchesForEmptyIncidents = await tx.loadExistingMatches(emptyComponentIncidentIds);

    const installed = await tx.loadInstalledDependencies(source.id);
    const finalStates = new Map<string, DependencyState>();
    let notificationsEnqueued = 0;

    for (const dependency of installed) {
      const nextState = resolveDependencyState(dependency.selector, dependency.scopeId, combined, snapshot);
      finalStates.set(dependency.id, nextState);
      await tx.applyDependencyState(dependency.id, dependency.currentState, {
        state: nextState,
        observedAt: context.now,
        providerUpdatedAt: snapshot.providerUpdatedAt ? new Date(snapshot.providerUpdatedAt) : null,
      }, context.now);

      for (const incident of incidents) {
        const incidentInternalId = incidentInternalIds.get(incident.externalId);
        if (!incidentInternalId) continue;

        let isNewMatch: boolean;
        if (incident.componentIds.length > 0) {
          if (!selectorIntersectsIncident(dependency.selector, dependency.scopeId, incident.componentIds)) continue;
          const matchKind = associationKind === "inferred" ? "inferred" : "component_match";
          isNewMatch = await tx.upsertDependencyIncidentMatch(dependency.id, incidentInternalId, matchKind, context.now);
        } else {
          if (!existingMatchesForEmptyIncidents.has(`${dependency.id}:${incidentInternalId}`)) continue;
          isNewMatch = false;
        }

        // The event is derived from the incident's observed state transition
        // (see deriveNotificationEvent), using resolved_at as it stood
        // before this poll's own upserts. This makes the event fire exactly
        // once at transition time and holds even across an outbox purge,
        // since nothing here depends on a previously enqueued outbox row.
        const isActive = incident.resolvedAt === null;
        const priorResolvedAt = priorIncidentResolution.get(incident.externalId);
        const event = deriveNotificationEvent(isNewMatch, isActive, priorResolvedAt);
        if (event === null) continue;
        if (!dependency.notificationsEnabled || context.defaultRecipients.length === 0) continue;

        // An "incident" event on an incident that was stored resolved as of
        // the prior poll is the reopen case, regardless of whether the match
        // row is new this poll or predates the resolution: give it, and every
        // "recovery", a key distinct from the cycle that first used this
        // external id (see notificationKeyExternalId).
        const priorKnownResolved = priorResolvedAt !== undefined && priorResolvedAt !== null;
        const isReopen = event === "incident" && priorKnownResolved;
        const keyExternalId = notificationKeyExternalId(event, incident.externalId, isReopen, priorResolvedAt, incident.resolvedAt);

        const enqueued = await tx.enqueueNotification({
          event,
          sourceId: source.id,
          dependencyId: dependency.id,
          presetId: dependency.catalogId,
          scopeId: dependency.scopeId,
          dependencyName: dependency.presetName,
          provider: source.provider,
          incidentExternalId: keyExternalId,
          incidentTitle: incident.title,
          state: nextState,
          canonicalUrl: incident.canonicalUrl,
          providerTimestamp: incident.updatedAt,
          recipients: context.defaultRecipients,
        }, context.now);
        notificationsEnqueued += enqueued;
      }
    }

    await applyAllOperationalNextPoll(tx, source, finalStates, outcome, context.now, "snapshot");

    return { dependenciesEvaluated: installed.length, incidentsUpserted, notificationsEnqueued, flippedToUnknown: 0 };
  });
}

function errorCodeOf(error: Error): string {
  const withCode = error as { code?: string };
  return typeof withCode.code === "string" ? withCode.code : "UNKNOWN";
}

// -- Real Drizzle-backed store -------------------------------------------

export function createSqlPersistStore(db: Database): PersistStore {
  return {
    transaction: (work) => db.transaction(async (tx) => work({
      async loadInstalledDependencies(sourceId) {
        const rows = await tx.select({
          id: dependencies.id,
          catalogId: dependencies.catalogId,
          presetName: dependencyCatalog.displayName,
          scopeId: dependencies.scopeId,
          selector: dependencyCatalog.selector,
          notificationsEnabled: dependencies.notificationsEnabled,
          currentState: dependencyState.state,
        }).from(dependencies)
          .innerJoin(dependencyCatalog, eq(dependencyCatalog.id, dependencies.catalogId))
          .innerJoin(dependencyState, eq(dependencyState.dependencyId, dependencies.id))
          .where(and(
            eq(dependencyCatalog.sourceId, sourceId),
            // A dependency on a drift-disabled preset stays whatever
            // catalog-sync last set it to (UNKNOWN): excluding it here is
            // what stops this poll from recomputing and overwriting that.
            eq(dependencyCatalog.enabled, true),
            isNull(dependencies.removedAt),
          ));
        return rows.map((row) => ({ ...row, selector: row.selector as DependencySelector, currentState: row.currentState as DependencyState }));
      },

      async loadPriorIncidentResolution(sourceId, externalIds) {
        if (externalIds.length === 0) return new Map();
        const rows = await tx.select({
          externalId: providerIncidents.externalId,
          resolvedAt: providerIncidents.resolvedAt,
        }).from(providerIncidents)
          .where(and(eq(providerIncidents.sourceId, sourceId), inArray(providerIncidents.externalId, [...externalIds])));
        return new Map(rows.map((row) => [row.externalId, row.resolvedAt]));
      },

      async loadExistingMatches(incidentIds) {
        if (incidentIds.length === 0) return new Set();
        const rows = await tx.select({
          dependencyId: dependencyIncidentMatches.dependencyId,
          incidentId: dependencyIncidentMatches.incidentId,
        }).from(dependencyIncidentMatches)
          .where(inArray(dependencyIncidentMatches.incidentId, [...incidentIds]));
        return new Set(rows.map((row) => `${row.dependencyId}:${row.incidentId}`));
      },

      async upsertIncident(sourceId, candidateId, incident) {
        const values = {
          id: candidateId,
          sourceId,
          externalId: incident.externalId,
          title: incident.title,
          state: incident.state as (typeof providerIncidents.$inferInsert)["state"],
          impact: incident.impact,
          startedAt: new Date(incident.startedAt),
          resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt) : null,
          providerUpdatedAt: new Date(incident.updatedAt),
          canonicalUrl: incident.canonicalUrl,
        };
        // Always updates on conflict rather than gating on setWhere: a
        // WHERE-skipped conflict returns no row via RETURNING in Postgres,
        // which would otherwise make this fall back to the wrong (freshly
        // generated) id for an unchanged incident. provider_incidents is one
        // row per incident regardless, so the extra write on an unchanged
        // poll is cheap and never grows storage.
        const [row] = await tx.insert(providerIncidents).values(values).onConflictDoUpdate({
          target: [providerIncidents.sourceId, providerIncidents.externalId],
          set: {
            title: values.title,
            state: values.state,
            impact: values.impact,
            resolvedAt: values.resolvedAt,
            providerUpdatedAt: values.providerUpdatedAt,
            canonicalUrl: values.canonicalUrl,
          },
        }).returning({ id: providerIncidents.id });
        return row?.id ?? candidateId;
      },

      async upsertIncidentComponents(incidentId, componentIds, associationKind) {
        if (componentIds.length === 0) return;
        await tx.insert(providerIncidentComponents)
          .values(componentIds.map((externalComponentId) => ({ incidentId, externalComponentId, associationKind })))
          .onConflictDoNothing();
      },

      async upsertIncidentUpdates(incidentId, updates) {
        if (updates.length === 0) return;
        await tx.insert(providerIncidentUpdates)
          .values(updates.map((update) => ({
            incidentId,
            externalUpdateId: update.externalId,
            state: update.state as (typeof providerIncidentUpdates.$inferInsert)["state"],
            bodyText: update.bodyText,
            providerCreatedAt: new Date(update.createdAt),
            providerUpdatedAt: new Date(update.updatedAt),
          })))
          .onConflictDoNothing();
      },

      async upsertDependencyIncidentMatch(dependencyId, incidentId, matchKind, now) {
        const rows = await tx.insert(dependencyIncidentMatches)
          .values({ dependencyId, incidentId, matchKind, matchedAt: now })
          .onConflictDoNothing()
          .returning({ dependencyId: dependencyIncidentMatches.dependencyId });
        return rows.length > 0;
      },

      async applyDependencyState(dependencyId, previousState, next, now) {
        await tx.update(dependencyState).set({
          state: next.state,
          checking: false,
          observedAt: next.observedAt,
          providerUpdatedAt: next.providerUpdatedAt,
          lastSuccessfulPollAt: now,
          ...(next.state !== previousState ? { stateStartedAt: now } : {}),
        }).where(eq(dependencyState.dependencyId, dependencyId));

        if (next.state === previousState) return;

        // greatest(now, started_at) rather than a bare `now`: under
        // cross-instance clock skew a slightly-behind now could otherwise
        // land before the interval's own started_at and fail the
        // ended_at >= started_at check, aborting the whole poll transaction.
        await tx.update(dependencyStateIntervals).set({ endedAt: sql`greatest(${now}, ${dependencyStateIntervals.startedAt})` })
          .where(and(eq(dependencyStateIntervals.dependencyId, dependencyId), isNull(dependencyStateIntervals.endedAt)));
        await tx.insert(dependencyStateIntervals).values({
          id: randomUUID(),
          dependencyId,
          state: next.state,
          startedAt: now,
          endedAt: null,
          sourceObservedAt: next.observedAt,
        });
      },

      async enqueueNotification(input, now) {
        // Runs on the same tx handle as every other write in this
        // transaction, so the outbox row commits and rolls back with the
        // state, interval, and match writes rather than autocommitting on
        // a separate connection.
        return enqueueDependencyNotifications(tx, {
          event: input.event,
          sourceId: input.sourceId,
          incidentExternalId: input.incidentExternalId,
          presetId: input.presetId,
          scopeId: input.scopeId,
          dependencyId: input.dependencyId,
          dependencyName: input.dependencyName,
          provider: input.provider,
          incidentTitle: input.incidentTitle,
          state: input.state,
          canonicalUrl: input.canonicalUrl,
          providerTimestamp: input.providerTimestamp,
          recipients: input.recipients,
        }, { now });
      },

      async updateSourceHealthSuccess(sourceId, patch) {
        await tx.update(dependencySources).set({
          etag: patch.etag,
          lastModified: patch.lastModified,
          lastAttemptAt: patch.now,
          lastSuccessAt: patch.now,
          consecutiveFailures: 0,
          lastErrorCode: null,
          nextPollAt: patch.nextPollAt,
        }).where(eq(dependencySources.id, sourceId));
      },

      async updateSourceHealthNotModified(sourceId, patch) {
        await tx.update(dependencySources).set({
          lastAttemptAt: patch.now,
          lastSuccessAt: patch.now,
          consecutiveFailures: 0,
          lastErrorCode: null,
          nextPollAt: patch.nextPollAt,
        }).where(eq(dependencySources.id, sourceId));
      },

      async updateSourceHealthFailure(sourceId, patch) {
        await tx.update(dependencySources).set({
          lastAttemptAt: patch.now,
          consecutiveFailures: patch.consecutiveFailures,
          lastErrorCode: patch.errorCode,
          nextPollAt: patch.nextPollAt,
        }).where(eq(dependencySources.id, sourceId));
      },
    })),
  };
}
