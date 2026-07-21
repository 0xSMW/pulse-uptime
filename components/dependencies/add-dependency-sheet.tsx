"use client"

import { Search } from "lucide-react"
import { useRouter } from "next/navigation"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import useSWR from "swr"

import { DependencyFidelityBadge } from "@/components/dependencies/dependency-status"
import { ProviderMark } from "@/components/dependencies/provider-marks"
import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
  SettingsApiError,
} from "@/components/settings/settings-api"
import { Sheet } from "@/components/settings/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  DependencyCatalogCategory,
  DependencyCatalogPreset,
} from "@/lib/dependencies/queries"
import type { ScopeSelection } from "@/lib/dependencies/types"
import { cn } from "@/lib/utils"

// Category slugs come from lib/db/schema.ts's dependencyCategories const.
// Labels mirror the section headings in Docs/Specs/DEPENDENCY-MONITORING.md's
// "Catalog candidates" list.
const categoryLabels: Record<string, string> = {
  ai: "AI",
  hosting: "Hosting and network",
  auth: "Authentication",
  data: "Data",
  payments: "Payments and communication",
  developer: "Developer infrastructure",
}

/**
 * Select value for the optional unscoped choice. Radix Select rejects empty
 * strings, so the UI stores this sentinel and maps it to scopeId null.
 */
export const ALL_LOCATIONS_VALUE = "__all_locations__"

export function categoryLabel(category: string): string {
  return categoryLabels[category] ?? category
}

/**
 * Filters catalog categories by preset or provider name, dropping categories
 * left with no matches. Mirrors the plain-substring search convention used
 * by the monitor table and command palette (no fuzzy scoring). Exported for
 * tests.
 */
export function filterCatalogCategories(
  categories: readonly DependencyCatalogCategory[],
  query: string
): DependencyCatalogCategory[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return categories.map((category) => ({ ...category }))
  }
  return categories
    .map((category) => ({
      ...category,
      presets: category.presets.filter((preset) =>
        `${preset.name}\n${preset.provider}`.toLowerCase().includes(needle)
      ),
    }))
    .filter((category) => category.presets.length > 0)
}

export type SelectedScopeResult =
  | { ready: true; scopeId: string | null }
  | { ready: false }

/**
 * Resolves the install scope for a preset from the user's select state.
 * Static and discovered scopeSelection share this path. Returns ready:false
 * when install must not proceed (missing required choice, pending discovery,
 * unavailable options, or an unavailable selected option).
 */
export function selectedScopeForPreset(
  preset: Pick<DependencyCatalogPreset, "scopeSelection">,
  selectionByPreset: Readonly<Record<string, string>>,
  presetId: string
): SelectedScopeResult {
  const selection = preset.scopeSelection
  if (!selection) {
    return { ready: true, scopeId: null }
  }

  const raw = selectionByPreset[presetId]

  // Optional unscoped installs match the server: null scopeId is valid without
  // waiting for discovery. A concrete location still needs a ready option list.
  if (selection.allowsUnscoped) {
    if (raw === undefined || raw === ALL_LOCATIONS_VALUE) {
      return { ready: true, scopeId: null }
    }
    if (selection.status === "pending" || selection.status === "unavailable") {
      return { ready: false }
    }
    const option = selection.options.find((entry) => entry.id === raw)
    if (!option?.available) {
      return { ready: false }
    }
    return { ready: true, scopeId: option.id }
  }

  if (selection.status === "pending" || selection.status === "unavailable") {
    return { ready: false }
  }

  // status is static | ready: options come from the catalog (static) or a
  // completed discovery pass (ready).
  if (!raw || raw === ALL_LOCATIONS_VALUE) {
    // Required scope with no available option chosen yet.
    return { ready: false }
  }

  const option = selection.options.find((entry) => entry.id === raw)
  if (!option?.available) {
    return { ready: false }
  }
  return { ready: true, scopeId: option.id }
}

/**
 * Catalog-data message when discovery is not ready for install. Empty when
 * the selector can render. Short warning copy only, per Agents.md.
 * Optional unscoped presets do not need discovery to complete.
 */
export function scopeDiscoveryMessage(
  selection: ScopeSelection | null
): string {
  if (!selection) {
    return ""
  }
  if (selection.allowsUnscoped) {
    return ""
  }
  if (selection.status === "pending") {
    return "Catalog data not ready"
  }
  if (selection.status === "unavailable") {
    return "Catalog scopes unavailable"
  }
  return ""
}

/** Whether the compact scope Select should render for this selection. */
export function showsScopeSelector(selection: ScopeSelection | null): boolean {
  return (
    selection !== null &&
    (selection.status === "static" || selection.status === "ready")
  )
}

/**
 * Controlled Select value for a preset. Optional scopes default to the
 * All locations sentinel so the control shows a real choice at rest.
 */
export function scopeSelectValue(
  selection: ScopeSelection,
  selectionByPreset: Readonly<Record<string, string>>,
  presetId: string
): string | undefined {
  const raw = selectionByPreset[presetId]
  if (raw) {
    return raw
  }
  if (selection.allowsUnscoped) {
    return ALL_LOCATIONS_VALUE
  }
}

function rowKey(presetId: string, scopeId: string | null): string {
  return `${presetId}|${scopeId ?? ""}`
}

function addErrorMessage(error: unknown): string {
  if (error instanceof SettingsApiError) {
    if (error.code === "DEPENDENCY_EXISTS") {
      return "Already added"
    }
    if (error.code === "SCOPE_REQUIRED") {
      return "Select a scope"
    }
    if (error.code === "INVALID_SCOPE") {
      return "Choose a valid scope"
    }
    if (error.code === "SCOPE_OPTIONS_UNAVAILABLE") {
      return "Catalog data not ready"
    }
    if (error.code === "SCOPE_NO_LONGER_AVAILABLE") {
      return "Scope no longer available"
    }
    if (error.code === "PRESET_UNAVAILABLE") {
      return "Not available right now"
    }
  }
  return messageForError(error)
}

export function AddDependencySheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const {
    data: categories,
    isLoading: loading,
    error: catalogError,
  } = useSWR<DependencyCatalogCategory[]>(
    "/api/v1/dependency-catalog",
    async (url: string) => {
      const response =
        await apiRequest<
          ApiEnvelope<{ categories: DependencyCatalogCategory[] }>
        >(url)
      return response.data.categories
    }
  )
  const loadError = catalogError ? messageForError(catalogError) : ""
  const [query, setQuery] = useState("")
  const [scopeByPreset, setScopeByPreset] = useState<Record<string, string>>({})
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set())
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const visibleCategories = useMemo(
    () => filterCatalogCategories(categories ?? [], query),
    [categories, query]
  )
  const visiblePresets = useMemo(
    () => visibleCategories.flatMap((category) => category.presets),
    [visibleCategories]
  )

  function isAdded(
    preset: DependencyCatalogPreset,
    scopeId: string | null
  ): boolean {
    if (scopeId) {
      return (
        preset.installedScopeIds.includes(scopeId) ||
        addedKeys.has(rowKey(preset.id, scopeId))
      )
    }
    return preset.installed || addedKeys.has(rowKey(preset.id, null))
  }

  async function addPreset(
    preset: DependencyCatalogPreset,
    scopeId: string | null
  ) {
    const key = rowKey(preset.id, scopeId)
    setBusyKey(key)
    setRowErrors((current) => ({ ...current, [key]: "" }))
    try {
      await apiRequest(
        "/api/v1/dependencies",
        {
          method: "POST",
          body: JSON.stringify(
            scopeId ? { presetId: preset.id, scopeId } : { presetId: preset.id }
          ),
        },
        true
      )
      setAddedKeys((current) => new Set(current).add(key))
      router.refresh()
    } catch (error) {
      setRowErrors((current) => ({ ...current, [key]: addErrorMessage(error) }))
    } finally {
      setBusyKey((current) => (current === key ? null : current))
    }
  }

  function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) =>
        Math.min(current + 1, Math.max(visiblePresets.length - 1, 0))
      )
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const preset = visiblePresets[activeIndex]
      if (!preset) {
        return
      }
      // Same gate as the Add button: never POST an incomplete scope request.
      const resolved = selectedScopeForPreset(preset, scopeByPreset, preset.id)
      if (!resolved.ready) {
        return
      }
      if (!preset.enabled || preset.hasValidationError) {
        return
      }
      if (isAdded(preset, resolved.scopeId)) {
        return
      }
      void addPreset(preset, resolved.scopeId)
    }
  }

  function handleClose() {
    router.refresh()
    onClose()
  }

  const activePreset = visiblePresets[activeIndex]

  return (
    <Sheet
      description="Add provider status monitoring"
      onClose={handleClose}
      open={open}
      title="Add Dependency"
      // Wider than the default sheet so a long name, the Scope select, and the
      // Add button share one row without the name truncating too early.
      widthClassName="w-[min(560px,100vw)]"
    >
      <div className="relative mb-4">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--fg-muted)]"
        />
        <Input
          aria-activedescendant={
            activePreset ? `dependency-option-${activePreset.id}` : undefined
          }
          aria-controls="dependency-catalog-list"
          aria-label="Search services"
          className="pl-9"
          onChange={(event) => {
            setQuery(event.target.value)
            // Reset the keyboard highlight to the top whenever the filter
            // changes, in the handler that owns the change, not an Effect.
            setActiveIndex(0)
          }}
          onKeyDown={handleInputKey}
          placeholder="Search services"
          ref={inputRef}
          value={query}
        />
      </div>
      {loading ? (
        <p className="py-10 text-center text-[13px] text-[var(--fg-muted)]">
          Loading services…
        </p>
      ) : loadError ? (
        <p
          className="py-10 text-center text-[13px] text-[var(--down-text)]"
          role="alert"
        >
          {loadError}
        </p>
      ) : (
        <div
          aria-label="Dependency catalog"
          id="dependency-catalog-list"
          role="listbox"
        >
          {visibleCategories.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--fg-muted)]">
              No services match
            </p>
          ) : (
            visibleCategories.map((category) => (
              <div className="mb-4" key={category.category}>
                <div className="px-1 py-1.5 font-medium text-[11px] text-[var(--fg-faint)] uppercase tracking-[0.04em]">
                  {categoryLabel(category.category)}
                </div>
                <div className="space-y-0.5">
                  {category.presets.map((preset) => {
                    const index = visiblePresets.indexOf(preset)
                    const active = index === activeIndex
                    const selection = preset.scopeSelection
                    const resolved = selectedScopeForPreset(
                      preset,
                      scopeByPreset,
                      preset.id
                    )
                    const scopeId = resolved.ready ? resolved.scopeId : null
                    const added = resolved.ready
                      ? isAdded(preset, scopeId)
                      : false
                    const key = rowKey(preset.id, scopeId)
                    const busy = busyKey === key
                    const rowError = rowErrors[key]
                    const discoveryMessage = scopeDiscoveryMessage(selection)
                    // Matches the server install gate, which accepts a
                    // never-validated preset and rejects only a disabled one or
                    // one with a recorded validationError. Validation is drift
                    // detection against the shipped catalog, not pre-clearance,
                    // so it is not required to add. Scope readiness is the W7
                    // client-side gate over scopeSelection.
                    const canAdd =
                      preset.enabled &&
                      !preset.hasValidationError &&
                      resolved.ready
                    const showSelector = showsScopeSelector(selection)
                    return (
                      <div
                        aria-selected={active}
                        className={cn(
                          "rounded-[8px] px-2.5 py-2",
                          active && "bg-[var(--hover)]"
                        )}
                        id={`dependency-option-${preset.id}`}
                        key={preset.id}
                        onMouseMove={() => setActiveIndex(index)}
                        role="option"
                        title={preset.sourceScopeNote ?? undefined}
                      >
                        {/* Grid so the name column flexes and truncates while the
                            leading brand mark and the right controls keep a fixed
                            width and never wrap onto a second row. */}
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5">
                          {/* Muted monochrome brand mark, no vendor colors, so the
                              row stays calm and reads as one system. */}
                          <ProviderMark provider={preset.provider} />
                          <div className="min-w-0">
                            <p
                              className="truncate font-medium text-[13px]"
                              title={preset.name}
                            >
                              {preset.name}
                            </p>
                            <div className="flex min-w-0 items-center gap-1.5 text-[var(--fg-muted)] text-xs">
                              <span className="truncate">
                                {preset.provider}
                              </span>
                              <DependencyFidelityBadge
                                className="shrink-0"
                                fidelity={preset.fidelity}
                              />
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {showSelector && selection ? (
                              <Select
                                onValueChange={(value) =>
                                  setScopeByPreset((current) => ({
                                    ...current,
                                    [preset.id]: value,
                                  }))
                                }
                                value={scopeSelectValue(
                                  selection,
                                  scopeByPreset,
                                  preset.id
                                )}
                              >
                                <SelectTrigger
                                  aria-label={`Scope for ${preset.name}`}
                                  className="h-8 w-[150px] text-xs"
                                >
                                  <SelectValue placeholder="Scope" />
                                </SelectTrigger>
                                <SelectContent>
                                  {selection.allowsUnscoped ? (
                                    <SelectItem value={ALL_LOCATIONS_VALUE}>
                                      All locations
                                    </SelectItem>
                                  ) : null}
                                  {selection.options.map((option) => (
                                    <SelectItem
                                      disabled={!option.available}
                                      key={option.id}
                                      value={option.id}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <Button
                              disabled={added || busy || !canAdd}
                              onClick={() => {
                                if (!resolved.ready) {
                                  return
                                }
                                void addPreset(preset, resolved.scopeId)
                              }}
                              size="sm"
                              type="button"
                              variant={added ? "secondary" : "primary"}
                            >
                              {added ? "Added" : busy ? "Adding…" : "Add"}
                            </Button>
                          </div>
                        </div>
                        {discoveryMessage ? (
                          <p className="mt-1 max-w-[320px] text-[var(--fg-faint)] text-xs">
                            {discoveryMessage}
                          </p>
                        ) : null}
                        {rowError ? (
                          <p
                            className="mt-1 text-[var(--down-text)] text-xs"
                            role="alert"
                          >
                            {rowError}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Sheet>
  )
}
