"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { DependencyFidelityBadge } from "@/components/dependencies/dependency-status";
import { Sheet } from "@/components/settings/sheet";
import { apiRequest, messageForError, SettingsApiError, type ApiEnvelope } from "@/components/settings/settings-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DependencyCatalogCategory, DependencyCatalogPreset } from "@/lib/dependencies/queries";
import type { ScopeSelection } from "@/lib/dependencies/types";
import { cn } from "@/lib/utils";

// Category slugs come from lib/db/schema.ts's dependencyCategories const.
// Labels mirror the section headings in Docs/DEPENDENCY-MONITORING.md's
// "Catalog candidates" list.
const categoryLabels: Record<string, string> = {
  ai: "AI",
  hosting: "Hosting and network",
  auth: "Authentication",
  data: "Data",
  payments: "Payments and communication",
  developer: "Developer infrastructure",
};

/**
 * Select value for the optional unscoped choice. Radix Select rejects empty
 * strings, so the UI stores this sentinel and maps it to scopeId null.
 */
export const ALL_LOCATIONS_VALUE = "__all_locations__";

export function categoryLabel(category: string): string {
  return categoryLabels[category] ?? category;
}

/**
 * Filters catalog categories by preset or provider name, dropping categories
 * left with no matches. Mirrors the plain-substring search convention used
 * by the monitor table and command palette (no fuzzy scoring). Exported for
 * tests.
 */
export function filterCatalogCategories(
  categories: readonly DependencyCatalogCategory[],
  query: string,
): DependencyCatalogCategory[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return categories.map((category) => ({ ...category }));
  return categories
    .map((category) => ({
      ...category,
      presets: category.presets.filter((preset) =>
        `${preset.name}\n${preset.provider}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((category) => category.presets.length > 0);
}

export type SelectedScopeResult =
  | { ready: true; scopeId: string | null }
  | { ready: false };

/**
 * Resolves the install scope for a preset from the user's select state.
 * Static and discovered scopeSelection share this path. Returns ready:false
 * when install must not proceed (missing required choice, pending discovery,
 * unavailable options, or an unavailable selected option).
 */
export function selectedScopeForPreset(
  preset: Pick<DependencyCatalogPreset, "scopeSelection">,
  selectionByPreset: Readonly<Record<string, string>>,
  presetId: string,
): SelectedScopeResult {
  const selection = preset.scopeSelection;
  if (!selection) return { ready: true, scopeId: null };

  const raw = selectionByPreset[presetId];

  // Optional unscoped installs match the server: null scopeId is valid without
  // waiting for discovery. A concrete location still needs a ready option list.
  if (selection.allowsUnscoped) {
    if (raw === undefined || raw === ALL_LOCATIONS_VALUE) {
      return { ready: true, scopeId: null };
    }
    if (selection.status === "pending" || selection.status === "unavailable") {
      return { ready: false };
    }
    const option = selection.options.find((entry) => entry.id === raw);
    if (!option || !option.available) return { ready: false };
    return { ready: true, scopeId: option.id };
  }

  if (selection.status === "pending" || selection.status === "unavailable") {
    return { ready: false };
  }

  // status is static | ready: options come from the catalog (static) or a
  // completed discovery pass (ready).
  if (!raw || raw === ALL_LOCATIONS_VALUE) {
    // Required scope with no available option chosen yet.
    return { ready: false };
  }

  const option = selection.options.find((entry) => entry.id === raw);
  if (!option || !option.available) return { ready: false };
  return { ready: true, scopeId: option.id };
}

/**
 * Catalog-data message when discovery is not ready for install. Empty when
 * the selector can render. Short warning copy only, per Agents.md.
 * Optional unscoped presets do not need discovery to complete.
 */
export function scopeDiscoveryMessage(selection: ScopeSelection | null): string {
  if (!selection) return "";
  if (selection.allowsUnscoped) return "";
  if (selection.status === "pending") return "Catalog data not ready";
  if (selection.status === "unavailable") return "Catalog scopes unavailable";
  return "";
}

/** Whether the compact scope Select should render for this selection. */
export function showsScopeSelector(selection: ScopeSelection | null): boolean {
  return selection !== null && (selection.status === "static" || selection.status === "ready");
}

/**
 * Controlled Select value for a preset. Optional scopes default to the
 * All locations sentinel so the control shows a real choice at rest.
 */
export function scopeSelectValue(
  selection: ScopeSelection,
  selectionByPreset: Readonly<Record<string, string>>,
  presetId: string,
): string | undefined {
  const raw = selectionByPreset[presetId];
  if (raw) return raw;
  if (selection.allowsUnscoped) return ALL_LOCATIONS_VALUE;
  return undefined;
}

function rowKey(presetId: string, scopeId: string | null): string {
  return `${presetId}|${scopeId ?? ""}`;
}

function addErrorMessage(error: unknown): string {
  if (error instanceof SettingsApiError) {
    if (error.code === "DEPENDENCY_EXISTS") return "Already added";
    if (error.code === "SCOPE_REQUIRED") return "Select a scope";
    if (error.code === "INVALID_SCOPE") return "Choose a valid scope";
    if (error.code === "SCOPE_OPTIONS_UNAVAILABLE") return "Catalog data not ready";
    if (error.code === "SCOPE_NO_LONGER_AVAILABLE") return "Scope no longer available";
    if (error.code === "PRESET_UNAVAILABLE") return "Not available right now";
  }
  return messageForError(error);
}

export function AddDependencySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [categories, setCategories] = useState<DependencyCatalogCategory[]>([]);
  const [query, setQuery] = useState("");
  const [scopeByPreset, setScopeByPreset] = useState<Record<string, string>>({});
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    apiRequest<ApiEnvelope<{ categories: DependencyCatalogCategory[] }>>("/api/v1/dependency-catalog")
      .then((response) => {
        if (cancelled) return;
        setCategories(response.data.categories);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(messageForError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const visibleCategories = useMemo(() => filterCatalogCategories(categories, query), [categories, query]);
  const visiblePresets = useMemo(() => visibleCategories.flatMap((category) => category.presets), [visibleCategories]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function isAdded(preset: DependencyCatalogPreset, scopeId: string | null): boolean {
    if (scopeId) return preset.installedScopeIds.includes(scopeId) || addedKeys.has(rowKey(preset.id, scopeId));
    return preset.installed || addedKeys.has(rowKey(preset.id, null));
  }

  async function addPreset(preset: DependencyCatalogPreset, scopeId: string | null) {
    const key = rowKey(preset.id, scopeId);
    setBusyKey(key);
    setRowErrors((current) => ({ ...current, [key]: "" }));
    try {
      await apiRequest(
        "/api/v1/dependencies",
        { method: "POST", body: JSON.stringify(scopeId ? { presetId: preset.id, scopeId } : { presetId: preset.id }) },
        true,
      );
      setAddedKeys((current) => new Set(current).add(key));
      router.refresh();
    } catch (error) {
      setRowErrors((current) => ({ ...current, [key]: addErrorMessage(error) }));
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  }

  function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(visiblePresets.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const preset = visiblePresets[activeIndex];
      if (!preset) return;
      // Same gate as the Add button: never POST an incomplete scope request.
      const resolved = selectedScopeForPreset(preset, scopeByPreset, preset.id);
      if (!resolved.ready) return;
      if (!preset.enabled || preset.hasValidationError) return;
      if (isAdded(preset, resolved.scopeId)) return;
      void addPreset(preset, resolved.scopeId);
    }
  }

  function handleClose() {
    router.refresh();
    onClose();
  }

  const activePreset = visiblePresets[activeIndex];

  return (
    <Sheet title="Add Dependency" description="Add provider status monitoring" open={open} onClose={handleClose}>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--fg-muted)]" aria-hidden />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKey}
          placeholder="Search services"
          aria-label="Search services"
          aria-controls="dependency-catalog-list"
          aria-activedescendant={activePreset ? `dependency-option-${activePreset.id}` : undefined}
          className="pl-9"
        />
      </div>
      {loading ? (
        <p className="py-10 text-center text-[13px] text-[var(--fg-muted)]">Loading services…</p>
      ) : loadError ? (
        <p role="alert" className="py-10 text-center text-[13px] text-[var(--down-text)]">{loadError}</p>
      ) : (
        <div id="dependency-catalog-list" role="listbox" aria-label="Dependency catalog">
          {visibleCategories.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--fg-muted)]">No services match</p>
          ) : (
            visibleCategories.map((category) => (
              <div key={category.category} className="mb-4">
                <div className="px-1 py-1.5 text-[11px] font-medium tracking-[0.04em] text-[var(--fg-faint)] uppercase">
                  {categoryLabel(category.category)}
                </div>
                <div className="space-y-0.5">
                  {category.presets.map((preset) => {
                    const index = visiblePresets.indexOf(preset);
                    const active = index === activeIndex;
                    const selection = preset.scopeSelection;
                    const resolved = selectedScopeForPreset(preset, scopeByPreset, preset.id);
                    const scopeId = resolved.ready ? resolved.scopeId : null;
                    const added = resolved.ready ? isAdded(preset, scopeId) : false;
                    const key = rowKey(preset.id, scopeId);
                    const busy = busyKey === key;
                    const rowError = rowErrors[key];
                    const discoveryMessage = scopeDiscoveryMessage(selection);
                    // Matches the server install gate, which accepts a
                    // never-validated preset and rejects only a disabled one or
                    // one with a recorded validationError. Validation is drift
                    // detection against the shipped catalog, not pre-clearance,
                    // so it is not required to add. Scope readiness is the W7
                    // client-side gate over scopeSelection.
                    const canAdd =
                      preset.enabled && !preset.hasValidationError && resolved.ready;
                    const showSelector = showsScopeSelector(selection);
                    return (
                      <div
                        key={preset.id}
                        id={`dependency-option-${preset.id}`}
                        role="option"
                        aria-selected={active}
                        onMouseMove={() => setActiveIndex(index)}
                        className={cn("rounded-[8px] px-2.5 py-2", active && "bg-[var(--hover)]")}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            {/* Wordmark text only: dependency name plus provider,
                                no logos and no brand colors, per the spec's
                                "Entry point" section. */}
                            <p className="truncate text-[13px] font-medium">{preset.name}</p>
                            <div className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
                              <span className="truncate">{preset.provider}</span>
                              <DependencyFidelityBadge fidelity={preset.fidelity} />
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {showSelector && selection ? (
                              <Select
                                value={scopeSelectValue(selection, scopeByPreset, preset.id)}
                                onValueChange={(value) =>
                                  setScopeByPreset((current) => ({ ...current, [preset.id]: value }))
                                }
                              >
                                <SelectTrigger aria-label={`Scope for ${preset.name}`} className="h-8 w-[150px] text-xs">
                                  <SelectValue placeholder="Scope" />
                                </SelectTrigger>
                                <SelectContent>
                                  {selection.allowsUnscoped ? (
                                    <SelectItem value={ALL_LOCATIONS_VALUE}>All locations</SelectItem>
                                  ) : null}
                                  {selection.options.map((option) => (
                                    <SelectItem
                                      key={option.id}
                                      value={option.id}
                                      disabled={!option.available}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant={added ? "secondary" : "primary"}
                              disabled={added || busy || !canAdd}
                              onClick={() => {
                                if (!resolved.ready) return;
                                void addPreset(preset, resolved.scopeId);
                              }}
                            >
                              {added ? "Added" : busy ? "Adding…" : "Add"}
                            </Button>
                          </div>
                        </div>
                        {discoveryMessage ? (
                          <p className="mt-1 max-w-[320px] text-xs text-[var(--fg-faint)]">{discoveryMessage}</p>
                        ) : null}
                        {preset.sourceScopeNote ? (
                          <p className="mt-1 max-w-[320px] text-xs text-[var(--fg-faint)]">{preset.sourceScopeNote}</p>
                        ) : null}
                        {rowError ? <p role="alert" className="mt-1 text-xs text-[var(--down-text)]">{rowError}</p> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Sheet>
  );
}
