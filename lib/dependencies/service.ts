import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { dependencies, dependencyCatalog, dependencySources, dependencyState, dependencyStateIntervals } from "@/lib/db/schema";

import { getDependencyDetail as queryDependencyDetail, listCatalog as queryListCatalog, listDependenciesForDashboard } from "./queries";
import type { DependencyScope, DependencyState } from "./types";

// Install semantics per Docs/DEPENDENCY-MONITORING.md "One-click installation
// path": no provider credentials, one transaction, and a fresh-snapshot rule
// so a brand-new install never has to lie about its state.

const FRESHNESS_WINDOW_MS = 10 * 60_000;

export class DependencyApiError extends Error {
  constructor(
    readonly code:
      | "PRESET_NOT_FOUND"
      | "PRESET_UNAVAILABLE"
      | "SCOPE_REQUIRED"
      | "INVALID_SCOPE"
      | "DEPENDENCY_EXISTS"
      | "DEPENDENCY_NOT_FOUND",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DependencyApiError";
  }
}

export type DependencyPresetRow = {
  id: string;
  sourceId: string;
  enabled: boolean;
  validatedAt: Date | null;
  scope: DependencyScope | null;
};

export type DependencyRow = {
  id: string;
  catalogId: string;
  scopeId: string | null;
  notificationsEnabled: boolean;
  createdAt: Date;
  removedAt: Date | null;
};

export type DependencyStateSnapshot = {
  state: DependencyState;
  checking: boolean;
  observedAt: Date;
  providerUpdatedAt: Date | null;
};

export interface DependenciesStore {
  loadPreset(presetId: string): Promise<DependencyPresetRow | null>;
  /**
   * Seeds a fresh install from the most recent observation of the SAME
   * (catalogId, scopeId) pair, when one is fresh. Only a previously removed
   * dependency can share that pair with a brand-new install, since an active
   * duplicate is rejected before this ever gets a chance to matter. This
   * lets a quick reinstall reuse the provider's last known state instead of
   * a needless UNKNOWN bounce, while a stale or first-ever install still
   * falls through to UNKNOWN/checking.
   */
  loadRecentStateForCatalogScope(catalogId: string, scopeId: string | null, freshAfter: Date): Promise<DependencyStateSnapshot | null>;
  /**
   * Inserts the dependency, its opening state, and its opening interval, and
   * schedules the source for immediate polling, all in one transaction.
   * Returns false when the partial unique index on (catalogId, scopeId)
   * among active dependencies rejects the insert as a duplicate.
   */
  insertDependency(input: {
    dependency: DependencyRow;
    state: DependencyStateSnapshot;
    intervalId: string;
    sourceId: string;
    now: Date;
  }): Promise<boolean>;
  touchSourceNextPoll(sourceId: string, now: Date): Promise<void>;
  loadSourceIdForDependency(id: string): Promise<string | null>;
  /** Soft removal: sets removedAt and closes the open interval, in one transaction. Returns false when no active dependency matches. */
  removeDependency(id: string, now: Date): Promise<boolean>;
  patchNotifications(id: string, notificationsEnabled: boolean): Promise<boolean>;
}

export type DependenciesDependencies = {
  store?: DependenciesStore;
  now?: () => Date;
  newId?: () => string;
  /** Pins the installed dependency's own id to the idempotency operationId, mirroring status-reports' reportId pinning, so a crash-recovery retry finds the same row instead of inserting a second one. */
  dependencyId?: string;
};

export type InstallDependencyInput = {
  presetId: string;
  scopeId?: string | null;
  notificationsEnabled?: boolean;
};

/**
 * Validates the requested scopeId against the preset's scope contract.
 * `required_options` ships a static validated list in the catalog, so it is
 * checked exactly. `discovered_children` and `discovered_locations` resolve
 * their concrete option list at catalog-validation time (adapters, not yet
 * built as of this phase), so only presence is enforced here when required.
 */
function validateScope(scope: DependencyScope | null, scopeId: string | null | undefined): string | null {
  if (!scope) {
    if (scopeId) throw new DependencyApiError("INVALID_SCOPE", "This preset does not accept a scope");
    return null;
  }
  if (scope.kind === "required_options") {
    if (!scopeId) throw new DependencyApiError("SCOPE_REQUIRED", "This preset requires a scopeId");
    if (!scope.options.some((option) => option.id === scopeId)) {
      throw new DependencyApiError("INVALID_SCOPE", "scopeId is not one of the preset's validated options");
    }
    return scopeId;
  }
  if (scope.required && !scopeId) {
    throw new DependencyApiError("SCOPE_REQUIRED", "This preset requires a scopeId");
  }
  return scopeId ?? null;
}

export async function installDependency(
  input: InstallDependencyInput,
  dependenciesInput: DependenciesDependencies = {},
) {
  const store = dependenciesInput.store ?? databaseDependenciesStore;
  const now = dependenciesInput.now?.() ?? new Date();
  const newId = dependenciesInput.newId ?? (() => randomUUID());

  const preset = await store.loadPreset(input.presetId);
  if (!preset) throw new DependencyApiError("PRESET_NOT_FOUND", "Preset was not found");
  if (!preset.enabled || !preset.validatedAt) {
    throw new DependencyApiError("PRESET_UNAVAILABLE", "Preset is disabled or has not passed catalog validation");
  }
  const scopeId = validateScope(preset.scope, input.scopeId);

  const freshAfter = new Date(now.getTime() - FRESHNESS_WINDOW_MS);
  const recent = await store.loadRecentStateForCatalogScope(preset.id, scopeId, freshAfter);
  const state: DependencyStateSnapshot = recent ?? {
    state: "UNKNOWN",
    checking: true,
    observedAt: now,
    providerUpdatedAt: null,
  };

  const dependency: DependencyRow = {
    id: dependenciesInput.dependencyId ?? newId(),
    catalogId: preset.id,
    scopeId,
    notificationsEnabled: input.notificationsEnabled ?? true,
    createdAt: now,
    removedAt: null,
  };

  const inserted = await store.insertDependency({
    dependency,
    state,
    intervalId: newId(),
    sourceId: preset.sourceId,
    now,
  });
  if (!inserted) {
    throw new DependencyApiError("DEPENDENCY_EXISTS", "An active dependency already exists for this preset and scope");
  }

  const detail = await queryDependencyDetail(dependency.id);
  if (!detail) throw new Error("Dependency vanished immediately after insert");
  return detail;
}

/** Idempotency recovery for POST /api/v1/dependencies: the id is pinned to the operationId, so recovering is just "does a dependency with this id exist." */
export async function recoverInstalledDependency(id: string) {
  return queryDependencyDetail(id);
}

export async function listDependencies() {
  return listDependenciesForDashboard();
}

export async function getDependencyDetail(id: string) {
  const detail = await queryDependencyDetail(id);
  if (!detail) throw new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found");
  return detail;
}

export async function listCatalog() {
  return queryListCatalog();
}

const patchSchema = z.object({ notificationsEnabled: z.boolean() }).strict();

export async function patchDependency(
  id: string,
  input: unknown,
  dependenciesInput: DependenciesDependencies = {},
) {
  const store = dependenciesInput.store ?? databaseDependenciesStore;
  const parsed = patchSchema.parse(input);
  const patched = await store.patchNotifications(id, parsed.notificationsEnabled);
  if (!patched) throw new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found");
  return getDependencyDetail(id);
}

export async function removeDependency(
  id: string,
  dependenciesInput: DependenciesDependencies = {},
) {
  const store = dependenciesInput.store ?? databaseDependenciesStore;
  const now = dependenciesInput.now?.() ?? new Date();
  const removed = await store.removeDependency(id, now);
  if (!removed) throw new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found");
  return { id, removed: true };
}

/** Sets the source's next_poll_at to now and returns immediately; the cron picks up the fetch, so this route never touches the network. */
export async function refreshDependency(
  id: string,
  dependenciesInput: DependenciesDependencies = {},
) {
  const store = dependenciesInput.store ?? databaseDependenciesStore;
  const now = dependenciesInput.now?.() ?? new Date();
  const sourceId = await store.loadSourceIdForDependency(id);
  if (!sourceId) throw new DependencyApiError("DEPENDENCY_NOT_FOUND", "Dependency was not found");
  await store.touchSourceNextPoll(sourceId, now);
  return { id, refreshing: true };
}

export const databaseDependenciesStore: DependenciesStore = {
  async loadPreset(presetId) {
    const [row] = await db.select({
      id: dependencyCatalog.id,
      sourceId: dependencyCatalog.sourceId,
      enabled: dependencyCatalog.enabled,
      validatedAt: dependencyCatalog.validatedAt,
      scope: dependencyCatalog.scopeOptions,
    }).from(dependencyCatalog).where(eq(dependencyCatalog.id, presetId)).limit(1);
    return row ? { ...row, scope: (row.scope as DependencyScope | null) ?? null } : null;
  },

  async loadRecentStateForCatalogScope(catalogId, scopeId, freshAfter) {
    const [row] = await db.select({
      state: dependencyState.state,
      checking: dependencyState.checking,
      observedAt: dependencyState.observedAt,
      providerUpdatedAt: dependencyState.providerUpdatedAt,
    }).from(dependencyState)
      .innerJoin(dependencies, eq(dependencies.id, dependencyState.dependencyId))
      .where(and(
        eq(dependencies.catalogId, catalogId),
        scopeId === null ? isNull(dependencies.scopeId) : eq(dependencies.scopeId, scopeId),
        gte(dependencyState.observedAt, freshAfter),
      ))
      .orderBy(desc(dependencyState.observedAt))
      .limit(1);
    return row ? { ...row, state: row.state as DependencyState } : null;
  },

  async insertDependency({ dependency, state, intervalId, sourceId, now }) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(dependencies).values(dependency);
        await tx.insert(dependencyState).values({
          dependencyId: dependency.id,
          state: state.state,
          checking: state.checking,
          stateStartedAt: now,
          providerUpdatedAt: state.providerUpdatedAt,
          observedAt: state.observedAt,
          lastSuccessfulPollAt: null,
        });
        await tx.insert(dependencyStateIntervals).values({
          id: intervalId,
          dependencyId: dependency.id,
          state: state.state,
          startedAt: now,
          endedAt: null,
          sourceObservedAt: state.observedAt,
        });
        await tx.update(dependencySources).set({ nextPollAt: now }).where(eq(dependencySources.id, sourceId));
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    }
  },

  async touchSourceNextPoll(sourceId, now) {
    await db.update(dependencySources).set({ nextPollAt: now }).where(eq(dependencySources.id, sourceId));
  },

  async loadSourceIdForDependency(id) {
    const [row] = await db.select({ sourceId: dependencyCatalog.sourceId })
      .from(dependencies)
      .innerJoin(dependencyCatalog, eq(dependencyCatalog.id, dependencies.catalogId))
      .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
      .limit(1);
    return row?.sourceId ?? null;
  },

  async removeDependency(id, now) {
    return db.transaction(async (tx) => {
      const updated = await tx.update(dependencies).set({ removedAt: now })
        .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
        .returning({ id: dependencies.id });
      if (!updated[0]) return false;
      await tx.update(dependencyStateIntervals).set({ endedAt: now })
        .where(and(eq(dependencyStateIntervals.dependencyId, id), isNull(dependencyStateIntervals.endedAt)));
      return true;
    });
  },

  async patchNotifications(id, notificationsEnabled) {
    const updated = await db.update(dependencies).set({ notificationsEnabled })
      .where(and(eq(dependencies.id, id), isNull(dependencies.removedAt)))
      .returning({ id: dependencies.id });
    return Boolean(updated[0]);
  },
};
