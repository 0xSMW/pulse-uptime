"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useSyncExternalStore, type RefObject } from "react";

import type { LatencyPoint } from "@/components/charts/latency-chart";

// recharts is heavy; split it out of the route bundle AND defer downloading
// it until the chart container actually scrolls into view.
const LatencyChart = dynamic(
  () => import("@/components/charts/latency-chart").then((mod) => mod.LatencyChart),
  { loading: () => <ChartPlaceholder /> },
);

function ChartPlaceholder() {
  return <div className="h-[220px] w-full animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />;
}

// Subscribes to whether `containerRef`'s element has scrolled into view.
// Falls back to "immediately visible" when IntersectionObserver isn't
// available rather than never mounting the chart. Modeled as an external
// store (rather than useEffect + setState) so the "become visible" signal
// only ever flows out of a subscription callback, never synchronously out of
// an effect body. The server snapshot is always `false`, so SSR and the
// first client render agree — no hydration mismatch — and visibility only
// flips to `true` once React attaches the subscription on the client.
function useIsIntersecting(containerRef: RefObject<HTMLDivElement | null>) {
  const visibleRef = useRef(false);

  // Stabilized via useCallback (containerRef is a ref object, so it's
  // referentially stable across renders) — otherwise useSyncExternalStore
  // sees a "new" subscribe function on every parent re-render and tears down
  // + recreates the IntersectionObserver each time, right up until the chart
  // becomes visible.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const container = containerRef.current;
      if (!container || visibleRef.current) return () => {};

      if (typeof IntersectionObserver === "undefined") {
        visibleRef.current = true;
        onChange();
        return () => {};
      }

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            visibleRef.current = true;
            onChange();
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(container);
      return () => observer.disconnect();
    },
    [containerRef],
  );

  return useSyncExternalStore(
    subscribe,
    () => visibleRef.current,
    () => false,
  );
}

export function LazyLatencyChart({ data }: { data: LatencyPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const visible = useIsIntersecting(containerRef);

  return (
    <div ref={containerRef} className="h-[220px] w-full">
      {visible ? <LatencyChart data={data} /> : <ChartPlaceholder />}
    </div>
  );
}
