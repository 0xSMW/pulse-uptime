"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

import {
  livePollBackoffMs,
  livePollIntervalMs,
  livePollIsGone,
  livePollIsStale,
} from "@/lib/reporting/live-poll";
import type { MonitorPhase } from "@/lib/reporting/queries/first-run";
import type { MonitorLiveData } from "@/lib/reporting/queries/live-summary";
import type { MonitorState } from "@/components/monitors/status-dot";

// Carries the HTTP status so the retry policy can single out a gone monitor.
class LiveFetchError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Live summary failed with ${status}`);
    this.status = status;
  }
}

async function fetchLive(url: string): Promise<MonitorLiveData> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new LiveFetchError(response.status);
  const body = (await response.json()) as { data: MonitorLiveData };
  return body.data;
}

export type MonitorLiveStatus = {
  data: MonitorLiveData | null;
  updatedAt: number | null;
  isPaused: boolean;
  isStale: boolean;
};

// Polls the live summary for one monitor. The cadence follows the latest phase
// and state, SWR pauses the interval while the tab is hidden and revalidates on
// focus and reconnect, and repeated failures back off and mark the data stale.
// Charts and timeline bars stay on the server snapshot, so when a new completed
// rollup bucket appears the whole tree refreshes once to advance them.
export function useMonitorLive(
  monitorId: string,
  server: { phase: MonitorPhase; state: MonitorState; rollupVersion: string | null },
): MonitorLiveStatus {
  const router = useRouter();
  const [errorCount, setErrorCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [isHidden, setIsHidden] = useState(false);
  const refreshedVersionRef = useRef<string | null>(server.rollupVersion);
  const goneRef = useRef(false);

  // Track visibility so the indicator can show "Updates paused". SWR stops the
  // interval itself through refreshWhenHidden false.
  useEffect(() => {
    const sync = () => setIsHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const { data } = useSWR<MonitorLiveData>(
    `/api/v1/monitors/${encodeURIComponent(monitorId)}/live`,
    fetchLive,
    {
      refreshInterval: (latest) =>
        livePollIntervalMs({
          phase: latest?.firstRun.phase ?? server.phase,
          state: latest?.state ?? server.state,
        }),
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      dedupingInterval: 5_000,
      onSuccess: () => {
        setErrorCount(0);
        setUpdatedAt(Date.now());
      },
      onError: () => setErrorCount((count) => count + 1),
      onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
        // A gone monitor never recovers, so drop the retry and refresh once so
        // the server component resolves to its not-found path. The guard keeps a
        // repeated 404 from looping refreshes.
        if (livePollIsGone((error as { status?: number }).status)) {
          if (!goneRef.current) {
            goneRef.current = true;
            router.refresh();
          }
          return;
        }
        setTimeout(() => {
          // A hidden tab pauses polling, so a retry that fires while hidden is
          // dropped rather than flipping the indicator to stale. SWR revalidates
          // on focus when the tab returns.
          if (document.visibilityState === "hidden") return;
          revalidate({ retryCount });
        }, livePollBackoffMs(retryCount));
      },
    },
  );

  // The server snapshot moves the baseline forward after each refresh.
  useEffect(() => {
    refreshedVersionRef.current = server.rollupVersion;
  }, [server.rollupVersion]);

  // A newer completed bucket than the snapshot triggers exactly one refresh, so
  // the charts and timeline redraw without polling refetching the whole tree.
  useEffect(() => {
    const version = data?.rollupVersion;
    if (version && version !== refreshedVersionRef.current) {
      refreshedVersionRef.current = version;
      router.refresh();
    }
  }, [data?.rollupVersion, router]);

  return {
    data: data ?? null,
    updatedAt,
    isPaused: isHidden,
    isStale: livePollIsStale(errorCount),
  };
}
