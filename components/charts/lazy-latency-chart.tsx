"use client";

import dynamic from "next/dynamic";
import { useRef, useSyncExternalStore, type RefObject } from "react";

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

// Subscribes to whether `containerRef` has scrolled into view. Falls back to
// immediately visible when IntersectionObserver is unavailable, rather than
// never mounting the chart. Modeled on useSyncExternalStore so state changes
// only come from the subscription callback, never an effect body. Server
// snapshot is always `false`, so SSR and the first render agree: no hydration mismatch.
function useIsIntersecting(containerRef: RefObject<HTMLDivElement | null>) {
  const visibleRef = useRef(false);

  return useSyncExternalStore(
    (onChange) => {
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
