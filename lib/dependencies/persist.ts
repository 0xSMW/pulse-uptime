import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

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
import type { SqlExecutor } from "@/lib/notifications/sql";

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
  incidentExternalId: string;
  incidentTitle: string;
  state: string;
  canonicalUrl: string | null;
  providerTimestamp: string;
  recipients: readonly string[];
}

export interface PersistExecutor {
  loadInstalledDependencies(sourceId: string): Promise<InstalledDependencyRow[]>;
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
   * this is the transition signal FIX A uses to tell "just started
   * matching" from "still matching, same as last poll" apart.
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

    let incidentsUpserted = 0;
    const incidentInternalIds = new Map<string, string>();
    for (const incident of incidents) {
      const internalId = await tx.upsertIncident(source.id, randomUUID(), incident);
      incidentInternalIds.set(incident.externalId, internalId);
      await tx.upsertIncidentComponents(internalId, incident.componentIds, associationKind);
      await tx.upsertIncidentUpdates(internalId, incident.updates);
      incidentsUpserted += 1;
    }

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
        if (!selectorIntersectsIncident(dependency.selector, dependency.scopeId, incident.componentIds)) continue;
        const incidentInternalId = incidentInternalIds.get(incident.externalId);
        if (!incidentInternalId) continue;
        const matchKind = associationKind === "inferred" ? "inferred" : "component_match";
        const isNewMatch = await tx.upsertDependencyIncidentMatch(dependency.id, incidentInternalId, matchKind, context.now);

        // The match row's newness this poll is the transition signal, not
        // resolved/open alone: a match created for the first time on an
        // already-resolved incident (a historical incident found on
        // install, or one that opened and closed within a single poll gap)
        // sends nothing, since Pulse never sent an opening alert for it.
        // Only a brand-new match on a still-open incident is "incident",
        // and only an incident resolving on a match that already existed
        // is "recovery". The outbox idempotency key still guards against
        // repeats of the same event across later polls.
        const isActive = incident.resolvedAt === null;
        const event = isNewMatch && isActive ? "incident" : !isNewMatch && !isActive ? "recovery" : null;
        if (event === null) continue;
        if (!dependency.notificationsEnabled || context.defaultRecipients.length === 0) continue;

        const enqueued = await tx.enqueueNotification({
          event,
          sourceId: source.id,
          dependencyId: dependency.id,
          presetId: dependency.catalogId,
          scopeId: dependency.scopeId,
          dependencyName: dependency.presetName,
          provider: source.provider,
          incidentExternalId: incident.externalId,
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

export function createSqlPersistStore(db: Database, sqlExecutor: SqlExecutor): PersistStore {
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
        return enqueueDependencyNotifications(sqlExecutor, {
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
