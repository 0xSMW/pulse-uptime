"use client";

import { ArrowUpRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { StatusDot, stateLabels, type MonitorState } from "@/components/monitors/status-dot";
import { formatDuration, formatLatency } from "@/lib/reporting/format";
import { cn } from "@/lib/utils";

export type PaletteMonitor = {
  id: string;
  name: string;
  state: MonitorState;
  lastLatencyMs: number | null;
};

export type PaletteIncident = {
  id: string;
  monitorId: string;
  monitorName: string;
  openedAt: string;
  cause: string;
};

export type PaletteItem = {
  id: string;
  text: string;
  searchText: string;
  hint: string;
  href: string;
  external?: boolean;
  state?: MonitorState;
  down?: boolean;
};

export type PaletteGroup = {
  label: "Navigation" | "Monitors" | "Live Incidents";
  items: PaletteItem[];
};

const navigationItems: PaletteItem[] = [
  { id: "nav-overview", text: "Overview", searchText: "Overview", hint: "", href: "/" },
  { id: "nav-incidents", text: "Incidents", searchText: "Incidents", hint: "", href: "/incidents" },
  { id: "nav-settings", text: "Settings", searchText: "Settings", hint: "", href: "/settings/account" },
  { id: "nav-status", text: "Status Page", searchText: "Status Page", hint: "↗", href: "/status", external: true },
];

export function buildPaletteGroups(
  monitors: PaletteMonitor[],
  incidents: PaletteIncident[],
  now = new Date(),
): PaletteGroup[] {
  const incidentByMonitor = new Map(incidents.map((incident) => [incident.monitorId, incident]));
  const groups: PaletteGroup[] = [
    { label: "Navigation", items: navigationItems },
    {
      label: "Monitors",
      items: monitors.map((monitor) => ({
        id: `monitor-${monitor.id}`,
        text: monitor.name,
        searchText: monitor.name,
        hint: monitor.state === "DOWN"
          ? "Down"
          : monitor.lastLatencyMs !== null
            ? formatLatency(monitor.lastLatencyMs)
            : stateLabels[monitor.state],
        href: `/monitors/${encodeURIComponent(monitor.id)}`,
        state: monitor.state,
        down: monitor.state === "DOWN",
      })),
    },
  ];
  const live = monitors.filter((monitor) => monitor.state === "DOWN");
  if (live.length > 0) {
    groups.push({
      label: "Live Incidents",
      items: live.map((monitor) => {
        const incident = incidentByMonitor.get(monitor.id);
        const elapsedSeconds = incident
          ? Math.max(0, Math.floor((now.getTime() - new Date(incident.openedAt).getTime()) / 1_000))
          : 0;
        const cause = incident?.cause || "Availability check failed";
        return {
          id: `incident-${incident?.id ?? monitor.id}`,
          text: `${monitor.name} — ${cause}`,
          searchText: `${monitor.name} ${cause}`,
          hint: `ongoing · ${formatDuration(elapsedSeconds)}`,
          href: "/incidents",
          state: "DOWN",
          down: true,
        };
      }),
    });
  }
  return groups;
}

export function filterPaletteGroups(groups: PaletteGroup[], query: string): PaletteGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups.flatMap((group) => {
    const items = group.items.filter((item) => item.searchText.toLowerCase().includes(needle));
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}

export function nextPaletteIndex(index: number, key: "ArrowUp" | "ArrowDown", count: number): number {
  if (count <= 0) return 0;
  return key === "ArrowDown" ? Math.min(index + 1, count - 1) : Math.max(index - 1, 0);
}

type PaletteContextValue = { openPalette: () => void };
const PaletteContext = createContext<PaletteContextValue | null>(null);

export function useCommandPalette(): PaletteContextValue {
  const value = useContext(PaletteContext);
  if (!value) throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
  return value;
}

export function CommandPaletteProvider({
  monitors,
  incidents,
  children,
}: {
  monitors: PaletteMonitor[];
  incidents: PaletteIncident[];
  children: ReactNode;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const openPalette = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) closePalette();
        else openPalette();
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [closePalette, open, openPalette]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const groups = useMemo(() => buildPaletteGroups(monitors, incidents, now), [incidents, monitors, now]);
  const visibleGroups = useMemo(() => filterPaletteGroups(groups, query), [groups, query]);
  const visibleItems = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);

  useEffect(() => {
    const active = visibleItems[activeIndex];
    if (active) document.getElementById(`palette-option-${active.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleItems]);

  function runItem(item: PaletteItem) {
    closePalette();
    if (item.external) window.open(item.href, "_blank", "noopener,noreferrer");
    else router.push(item.href);
  }

  function handleInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => nextPaletteIndex(current, "ArrowDown", visibleItems.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => nextPaletteIndex(current, "ArrowUp", visibleItems.length));
    } else if (event.key === "Enter") {
      const item = visibleItems[activeIndex];
      if (item) {
        event.preventDefault();
        runItem(item);
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <PaletteContext.Provider value={{ openPalette }}>
      {children}
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[min(18vh,160px)]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePalette();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            className="flex max-h-[min(620px,70vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] shadow-[var(--modal-shadow)]"
          >
            <h2 id="command-palette-title" className="sr-only">Command Palette</h2>
            <div className="relative border-b border-[var(--border)]">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-[var(--fg-muted)]" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleInputKey}
                placeholder="Search pages and monitors"
                aria-label="Search commands"
                aria-controls="command-palette-list"
                aria-activedescendant={visibleItems[activeIndex] ? `palette-option-${visibleItems[activeIndex].id}` : undefined}
                className="h-14 w-full border-0 bg-transparent pr-4 pl-11 text-sm outline-none placeholder:text-[var(--fg-faint)]"
              />
            </div>
            <div id="command-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
              {visibleGroups.length > 0 ? visibleGroups.map((group) => (
                <div key={group.label} className="py-1">
                  <div className="px-2 py-1.5 text-[11px] font-medium tracking-[0.04em] text-[var(--fg-faint)] uppercase">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const index = visibleItems.indexOf(item);
                    const active = index === activeIndex;
                    return (
                      <button
                        key={item.id}
                        id={`palette-option-${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        tabIndex={-1}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => runItem(item)}
                        className={cn(
                          "flex h-10 w-full items-center gap-2 rounded-[6px] px-3 text-left text-[13px]",
                          active && "bg-[var(--hover)]",
                        )}
                      >
                        {item.state ? <StatusDot state={item.state} aria-hidden /> : null}
                        <span className="min-w-0 flex-1 truncate">{item.text}</span>
                        <span className={cn(
                          "flex shrink-0 items-center gap-1 font-data text-xs text-[var(--fg-muted)]",
                          item.down && "text-[var(--down-text)]",
                        )}>
                          {item.hint === "↗" ? <ArrowUpRight className="size-3.5" aria-label="Opens in a new tab" /> : item.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )) : (
                <div className="px-4 py-12 text-center text-[13px] text-[var(--fg-muted)]">
                  No matches. Try a monitor name or page.
                </div>
              )}
            </div>
            <footer className="flex items-center justify-end gap-4 border-t border-[var(--border)] px-4 py-2.5 font-data text-[10px] text-[var(--fg-faint)]">
              <span><kbd>↑↓</kbd> Navigate</span>
              <span><kbd>↵</kbd> Open</span>
              <span><kbd>esc</kbd> Close</span>
            </footer>
          </section>
        </div>
      ) : null}
    </PaletteContext.Provider>
  );
}
