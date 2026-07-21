"use client"

import dynamic from "next/dynamic"
import {
  type RefObject,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react"

import type { LatencyPoint } from "@/components/charts/latency-chart"

// Load Recharts outside the route bundle when the chart enters the viewport.
const LatencyChart = dynamic(
  () =>
    import("@/components/charts/latency-chart").then((mod) => mod.LatencyChart),
  { loading: () => <ChartPlaceholder /> }
)

function ChartPlaceholder() {
  return (
    <div
      aria-hidden
      className="h-[220px] w-full animate-pulse rounded bg-[var(--chip-bg)]"
    />
  )
}

// Subscribe to visibility without changing state from an effect. Mount
// immediately without IntersectionObserver. The false server snapshot keeps
// hydration consistent until the client reports visibility.
function useIsIntersecting(containerRef: RefObject<HTMLDivElement | null>) {
  const visibleRef = useRef(false)

  // Keep subscribe stable to prevent IntersectionObserver recreation during parent renders.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const container = containerRef.current
      if (!container || visibleRef.current) {
        return () => {
          // no-op unsubscribe
        }
      }

      if (typeof IntersectionObserver === "undefined") {
        visibleRef.current = true
        onChange()
        return () => {
          // no-op unsubscribe
        }
      }

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            visibleRef.current = true
            onChange()
          }
        },
        { rootMargin: "200px" }
      )
      observer.observe(container)
      return () => observer.disconnect()
    },
    [containerRef]
  )

  return useSyncExternalStore(
    subscribe,
    () => visibleRef.current,
    () => false
  )
}

export function LazyLatencyChart({ data }: { data: LatencyPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const visible = useIsIntersecting(containerRef)

  return (
    <div className="h-[220px] w-full" ref={containerRef}>
      {visible ? <LatencyChart data={data} /> : <ChartPlaceholder />}
    </div>
  )
}
