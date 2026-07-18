import { MonitorDetailSkeleton } from "@/components/monitors/monitor-detail-skeleton";

// Same geometry as the page's Suspense fallback (which additionally knows the
// monitor identity), so the loading.tsx -> fallback -> content sequence never
// shifts layout.
export default function MonitorDetailLoading() {
  return <MonitorDetailSkeleton />;
}
