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

function rowKey(presetId: string, scopeId: string | null): string {
  return `${presetId}|${scopeId ?? ""}`;
}

function addErrorMessage(error: unknown): string {
  if (error instanceof SettingsApiError) {
    if (error.code === "DEPENDENCY_EXISTS") return "Already added";
    if (error.code === "SCOPE_REQUIRED") return "Select a region";
    if (error.code === "INVALID_SCOPE") return "Choose a valid region";
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
  const [regionByPreset, setRegionByPreset] = useState<Record<string, string>>({});
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

  function selectedScopeFor(preset: DependencyCatalogPreset): string | null {
    if (preset.scope?.kind !== "required_options") return null;
    return regionByPreset[preset.id] ?? null;
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
      const scopeId = selectedScopeFor(preset);
      const needsScope = preset.scope?.kind === "required_options";
      if (needsScope && !scopeId) return;
      if (isAdded(preset, scopeId)) return;
      void addPreset(preset, scopeId);
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
                    const needsScope = preset.scope?.kind === "required_options";
                    const selectedScope = needsScope ? regionByPreset[preset.id] ?? "" : "";
                    const scopeId = needsScope ? (selectedScope || null) : null;
                    const added = isAdded(preset, scopeId);
                    const key = rowKey(preset.id, scopeId);
                    const busy = busyKey === key;
                    const rowError = rowErrors[key];
                    // Matches the server install gate, which accepts a
                    // never-validated preset and rejects only a disabled one or
                    // one with a recorded validationError. Validation is drift
                    // detection against the shipped catalog, not pre-clearance,
                    // so it is not required to add.
                    const canAdd = preset.enabled && !preset.hasValidationError && (!needsScope || Boolean(selectedScope));
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
                            {needsScope && preset.scope?.kind === "required_options" ? (
                              <Select
                                value={selectedScope || undefined}
                                onValueChange={(value) => setRegionByPreset((current) => ({ ...current, [preset.id]: value }))}
                              >
                                <SelectTrigger aria-label={`Region for ${preset.name}`} className="h-8 w-[150px] text-xs">
                                  <SelectValue placeholder="Region" />
                                </SelectTrigger>
                                <SelectContent>
                                  {preset.scope.options.map((option) => (
                                    <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant={added ? "secondary" : "primary"}
                              disabled={added || busy || !canAdd}
                              onClick={() => void addPreset(preset, scopeId)}
                            >
                              {added ? "Added" : busy ? "Adding…" : "Add"}
                            </Button>
                          </div>
                        </div>
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
