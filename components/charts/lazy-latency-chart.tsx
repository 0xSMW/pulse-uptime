"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

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

export function LazyLatencyChart({ data }: { data: LatencyPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "200px" });
    observer.observe(container);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={containerRef} className="h-[220px] w-full">
      {visible ? <LatencyChart data={data} /> : <ChartPlaceholder />}
    </div>
  );
}
