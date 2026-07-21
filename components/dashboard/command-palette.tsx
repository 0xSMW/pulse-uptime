"use client"

import { ArrowUpRight, Search } from "lucide-react"
import { useRouter } from "next/navigation"
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { DependencyStatusDot } from "@/components/dependencies/dependency-status"
import {
  StatusDot,
  stateLabels,
  type VisibleMonitorState,
} from "@/components/monitors/status-dot"
import type { DependencyState } from "@/lib/dependencies/types"
import { formatDuration, formatLatency } from "@/lib/reporting/format"
import { cn } from "@/lib/utils"

export interface PaletteMonitor {
  id: string
  name: string
  state: VisibleMonitorState
  latestLatencyMs: number | null
}

export interface PaletteDependency {
  id: string
  name: string
  state: DependencyState
  pending: boolean
  provider: string
  componentLabel: string | null
}

export interface PaletteIncident {
  id: string
  monitorId: string
  monitorName: string
  openedAt: string
  cause: string
}

interface PaletteItem {
  id: string
  text: string
  searchText: string
  hint: string
  href: string
  external?: boolean
  state?: VisibleMonitorState
  dependencyState?: DependencyState
  pending?: boolean
  down?: boolean
}

export interface PaletteGroup {
  label: "Navigation" | "Monitors" | "Dependencies" | "Live Incidents"
  items: PaletteItem[]
}

const navigationItems: PaletteItem[] = [
  {
    id: "nav-overview",
    text: "Overview",
    searchText: "Overview",
    hint: "",
    href: "/",
  },
  {
    id: "nav-incidents",
    text: "Incidents",
    searchText: "Incidents",
    hint: "",
    href: "/incidents",
  },
  {
    id: "nav-settings",
    text: "Settings",
    searchText: "Settings",
    hint: "",
    href: "/settings/account",
  },
  {
    id: "nav-status",
    text: "Status Page",
    searchText: "Status Page",
    hint: "↗",
    href: "/status",
    external: true,
  },
]

export function buildPaletteGroups(
  monitors: PaletteMonitor[],
  dependencies: PaletteDependency[],
  incidents: PaletteIncident[],
  now = new Date()
): PaletteGroup[] {
  const incidentByMonitor = new Map(
    incidents.map((incident) => [incident.monitorId, incident])
  )
  const groups: PaletteGroup[] = [
    { label: "Navigation", items: navigationItems },
    {
      label: "Monitors",
      items: monitors.map((monitor) => ({
        id: `monitor-${monitor.id}`,
        text: monitor.name,
        searchText: monitor.name,
        hint:
          monitor.state === "DOWN"
            ? "Down"
            : monitor.latestLatencyMs === null
              ? stateLabels[monitor.state]
              : formatLatency(monitor.latestLatencyMs),
        href: `/monitors/${encodeURIComponent(monitor.id)}`,
        state: monitor.state,
        down: monitor.state === "DOWN",
      })),
    },
  ]
  // Follows the DependencyPanel convention: the group is hidden entirely when
  // no dependencies exist, so accounts without dependencies see no bare
  // heading. Sits after Monitors, before the live incident group.
  if (dependencies.length > 0) {
    groups.push({
      label: "Dependencies",
      items: dependencies.map((dependency) => ({
        id: `dependency-${dependency.id}`,
        text: dependency.name,
        searchText: dependency.componentLabel
          ? `${dependency.name} ${dependency.provider} ${dependency.componentLabel}`
          : `${dependency.name} ${dependency.provider}`,
        hint: dependency.componentLabel
          ? `${dependency.provider} · ${dependency.componentLabel}`
          : dependency.provider,
        href: `/dependencies/${encodeURIComponent(dependency.id)}`,
        dependencyState: dependency.state,
        pending: dependency.pending,
      })),
    })
  }
  const live = monitors.filter((monitor) => monitor.state === "DOWN")
  if (live.length > 0) {
    groups.push({
      label: "Live Incidents",
      items: live.map((monitor) => {
        const incident = incidentByMonitor.get(monitor.id)
        const elapsedSeconds = incident
          ? Math.max(
              0,
              Math.floor(
                (now.getTime() - new Date(incident.openedAt).getTime()) / 1000
              )
            )
          : 0
        const cause = incident?.cause || "Availability check failed"
        return {
          id: `incident-${incident?.id ?? monitor.id}`,
          text: `${monitor.name} — ${cause}`,
          searchText: `${monitor.name} ${cause}`,
          hint: `ongoing · ${formatDuration(elapsedSeconds)}`,
          href: "/incidents",
          state: "DOWN",
          down: true,
        }
      }),
    })
  }
  return groups
}

export function filterPaletteGroups(
  groups: PaletteGroup[],
  query: string
): PaletteGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return groups
  }
  return groups.flatMap((group) => {
    const items = group.items.filter((item) =>
      item.searchText.toLowerCase().includes(needle)
    )
    return items.length > 0 ? [{ ...group, items }] : []
  })
}

export function nextPaletteIndex(
  index: number,
  key: "ArrowUp" | "ArrowDown",
  count: number
): number {
  if (count <= 0) {
    return 0
  }
  return key === "ArrowDown"
    ? Math.min(index + 1, count - 1)
    : Math.max(index - 1, 0)
}

interface PaletteContextValue {
  openPalette: () => void
}
const PaletteContext = createContext<PaletteContextValue | null>(null)

export function CommandPaletteProvider({
  monitorsPromise,
  dependenciesPromise,
  incidentsPromise,
  children,
}: {
  monitorsPromise: Promise<PaletteMonitor[]>
  dependenciesPromise: Promise<PaletteDependency[]>
  incidentsPromise: Promise<PaletteIncident[]>
  children: ReactNode
}) {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)

  const openPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setOpen(true)
  }, [])
  const closePalette = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => previousFocusRef.current?.focus())
  }, [])

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (open) {
          closePalette()
        } else {
          openPalette()
        }
      } else if (event.key === "Escape" && open) {
        event.preventDefault()
        closePalette()
      }
    }
    window.addEventListener("keydown", handleGlobalKey)
    return () => window.removeEventListener("keydown", handleGlobalKey)
  }, [closePalette, open, openPalette])

  return (
    <PaletteContext.Provider value={{ openPalette }}>
      {children}
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[min(18vh,160px)]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closePalette()
            }
          }}
        >
          <Suspense
            fallback={
              <PaletteDialogFrame>
                <PaletteDialogLoading />
              </PaletteDialogFrame>
            }
          >
            <PaletteDialog
              closePalette={closePalette}
              dependenciesPromise={dependenciesPromise}
              incidentsPromise={incidentsPromise}
              monitorsPromise={monitorsPromise}
            />
          </Suspense>
        </div>
      ) : null}
    </PaletteContext.Provider>
  )
}

function PaletteDialogFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="command-palette-title"
      aria-modal="true"
      className="flex max-h-[min(620px,70vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] shadow-[var(--modal-shadow)]"
      role="dialog"
    >
      <h2 className="sr-only" id="command-palette-title">
        Command Palette
      </h2>
      {children}
    </section>
  )
}

// Mirrors the resolved dialog's input row and footer, and autofocuses so
// keystrokes cannot leak to shortcuts behind the aria-modal overlay while the
// streamed palette data is still resolving.
function PaletteDialogLoading() {
  return (
    <>
      <div className="relative border-[var(--border)] border-b">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-[var(--fg-muted)]"
        />
        <input
          aria-label="Search commands"
          autoFocus
          className="h-14 w-full border-0 bg-transparent pr-4 pl-11 text-sm outline-none placeholder:text-[var(--fg-faint)]"
          placeholder="Search pages, monitors, and dependencies"
        />
      </div>
      <div
        aria-busy="true"
        aria-label="Loading commands"
        className="min-h-0 flex-1 overflow-y-auto p-2"
        role="status"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div
            className="my-1 h-10 animate-pulse rounded-[6px] bg-[var(--chip-bg)]"
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list that never reorders
            key={index}
          />
        ))}
      </div>
      <footer className="flex items-center justify-end gap-4 border-[var(--border)] border-t px-4 py-2.5 font-data text-[10px] text-[var(--fg-faint)]">
        <span>
          <kbd>↑↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <span>
          <kbd>esc</kbd> Close
        </span>
      </footer>
    </>
  )
}

function PaletteDialog({
  monitorsPromise,
  dependenciesPromise,
  incidentsPromise,
  closePalette,
}: {
  monitorsPromise: Promise<PaletteMonitor[]>
  dependenciesPromise: Promise<PaletteDependency[]>
  incidentsPromise: Promise<PaletteIncident[]>
  closePalette: () => void
}) {
  // Streamed from the layout; resolved by the time a human opens the palette,
  // so use() is effectively synchronous here.
  const monitors = use(monitorsPromise)
  const dependencies = use(dependenciesPromise)
  const incidents = use(incidentsPromise)
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    inputRef.current?.focus()
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const groups = useMemo(
    () => buildPaletteGroups(monitors, dependencies, incidents, now),
    [dependencies, incidents, monitors, now]
  )
  const visibleGroups = useMemo(
    () => filterPaletteGroups(groups, query),
    [groups, query]
  )
  const visibleItems = useMemo(
    () => visibleGroups.flatMap((group) => group.items),
    [visibleGroups]
  )

  useEffect(() => {
    const active = visibleItems[activeIndex]
    if (active) {
      document
        .getElementById(`palette-option-${active.id}`)
        ?.scrollIntoView({ block: "nearest" })
    }
  }, [activeIndex, visibleItems])

  function runItem(item: PaletteItem) {
    closePalette()
    if (item.external) {
      window.open(item.href, "_blank", "noopener,noreferrer")
    } else {
      router.push(item.href)
    }
  }

  function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) =>
        nextPaletteIndex(current, "ArrowDown", visibleItems.length)
      )
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) =>
        nextPaletteIndex(current, "ArrowUp", visibleItems.length)
      )
    } else if (event.key === "Enter") {
      const item = visibleItems[activeIndex]
      if (item) {
        event.preventDefault()
        runItem(item)
      }
    } else if (event.key === "Tab") {
      event.preventDefault()
      inputRef.current?.focus()
    }
  }

  return (
    <PaletteDialogFrame>
      <div className="relative border-[var(--border)] border-b">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-[var(--fg-muted)]"
        />
        <input
          aria-activedescendant={
            visibleItems[activeIndex]
              ? `palette-option-${visibleItems[activeIndex].id}`
              : undefined
          }
          aria-controls="command-palette-list"
          aria-label="Search commands"
          className="h-14 w-full border-0 bg-transparent pr-4 pl-11 text-sm outline-none placeholder:text-[var(--fg-faint)]"
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={handleInputKey}
          placeholder="Search pages, monitors, and dependencies"
          ref={inputRef}
          value={query}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        id="command-palette-list"
        role="listbox"
      >
        {visibleGroups.length > 0 ? (
          visibleGroups.map((group) => (
            <div className="py-1" key={group.label}>
              <div className="px-2 py-1.5 font-medium text-[11px] text-[var(--fg-faint)] uppercase tracking-[0.04em]">
                {group.label}
              </div>
              {group.items.map((item) => {
                const index = visibleItems.indexOf(item)
                const active = index === activeIndex
                return (
                  <button
                    aria-selected={active}
                    className={cn(
                      "flex h-10 w-full items-center gap-2 rounded-[6px] px-3 text-left text-[13px]",
                      active && "bg-[var(--hover)]"
                    )}
                    id={`palette-option-${item.id}`}
                    key={item.id}
                    onClick={() => runItem(item)}
                    onMouseMove={() => setActiveIndex(index)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    {item.dependencyState ? (
                      <DependencyStatusDot
                        aria-hidden
                        pending={item.pending}
                        state={item.dependencyState}
                      />
                    ) : item.state ? (
                      <StatusDot aria-hidden state={item.state} />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{item.text}</span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 font-data text-[var(--fg-muted)] text-xs",
                        item.down && "text-[var(--down-text)]"
                      )}
                    >
                      {item.hint === "↗" ? (
                        <ArrowUpRight
                          aria-label="Opens in a new tab"
                          className="size-3.5"
                        />
                      ) : (
                        item.hint
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ))
        ) : (
          <div className="px-4 py-12 text-center text-[13px] text-[var(--fg-muted)]">
            No matches. Try a monitor name or page.
          </div>
        )}
      </div>
      <footer className="flex items-center justify-end gap-4 border-[var(--border)] border-t px-4 py-2.5 font-data text-[10px] text-[var(--fg-faint)]">
        <span>
          <kbd>↑↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <span>
          <kbd>esc</kbd> Close
        </span>
      </footer>
    </PaletteDialogFrame>
  )
}
