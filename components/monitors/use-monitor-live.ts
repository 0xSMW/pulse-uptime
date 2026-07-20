"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

import {
  livePollBackoffMs,
  livePollConfigChanged,
  livePollIntervalMs,
  livePollIsStale,
  livePollIsTerminal,
  livePollUnlockAdvanced,
  livePollWindowAdvanced,
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
  server: {
    phase: MonitorPhase;
    state: MonitorState;
    rollupVersion: string | null;
    acceptedConfigToken: string | null;
    windowVersion: string;
    rangeUnlocked: { d30: boolean; d90: boolean };
  },
): MonitorLiveStatus {
  const router = useRouter();
  const [errorCount, setErrorCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [isHidden, setIsHidden] = useState(false);
  const refreshedVersionRef = useRef<string | null>(server.rollupVersion);
  const refreshedConfigRef = useRef<string | null>(server.acceptedConfigToken);
  const refreshedWindowRef = useRef<string | null>(server.windowVersion);
  const terminalRef = useRef(false);
  const unlockRefreshedRef = useRef(false);

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
      onError: (error) => {
        // A terminal status routes through onErrorRetry to refresh once. It must
        // not bump the stale counter, or the indicator flashes "Data may be
        // stale" during the redirect or not-found resolution.
        if (livePollIsTerminal((error as { status?: number }).status)) return;
        setErrorCount((count) => count + 1);
      },
      onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
        // A terminal status never recovers, so drop the retry and refresh once so
        // the server layout redirects to login or the server component resolves
        // to its not-found path. The guard keeps a repeat from looping refreshes.
        if (livePollIsTerminal((error as { status?: number }).status)) {
          if (!terminalRef.current) {
            terminalRef.current = true;
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

  // The accepted config token moves the baseline forward after each config refresh.
  useEffect(() => {
    refreshedConfigRef.current = server.acceptedConfigToken;
  }, [server.acceptedConfigToken]);

  // A config edit from another session advances the accepted snapshot while the
  // page holds its config fields from the server snapshot. One guarded refresh
  // pulls the new name, url, thresholds, or recipients so the detail view and
  // the edit sheet never submit from a stale config, including on a paused
  // monitor whose rollup version never advances. The guard clears once the
  // snapshot catches up.
  const acceptedConfigToken = data?.acceptedConfigToken ?? null;
  useEffect(() => {
    if (livePollConfigChanged(refreshedConfigRef.current, acceptedConfigToken)) {
      refreshedConfigRef.current = acceptedConfigToken;
      router.refresh();
    }
  }, [acceptedConfigToken, router]);

  // The server snapshot moves the completed-window baseline forward after each
  // refresh.
  useEffect(() => {
    refreshedWindowRef.current = server.windowVersion;
  }, [server.windowVersion]);

  // The completed 15-minute window boundary advances every 15 minutes while the
  // page holds the timeline and response chart from the server snapshot, so a
  // paused monitor whose rollup version never moves would show a live score aged
  // against a window the charts no longer match. One guarded refresh per boundary
  // has the server recompute both against the current window. The guard clears
  // once the snapshot catches up.
  const windowVersion = data?.windowVersion ?? null;
  useEffect(() => {
    if (livePollWindowAdvanced(refreshedWindowRef.current, windowVersion)) {
      refreshedWindowRef.current = windowVersion;
      router.refresh();
    }
  }, [windowVersion, router]);

  // A poll can cross the 30 or 90 day activation boundary while the page stays
  // open. The payload flips the unlock flag but carries no d30 or d90 score, so
  // one guarded refresh has the server recompute the full range. The guard clears
  // once the snapshot catches up, and this advances a paused monitor whose rollup
  // version would otherwise never move.
  const liveD30 = data?.rangeUnlocked.d30;
  const liveD90 = data?.rangeUnlocked.d90;
  useEffect(() => {
    if (liveD30 === undefined || liveD90 === undefined) return;
    if (
      livePollUnlockAdvanced(
        { d30: server.rangeUnlocked.d30, d90: server.rangeUnlocked.d90 },
        { d30: liveD30, d90: liveD90 },
      )
    ) {
      if (!unlockRefreshedRef.current) {
        unlockRefreshedRef.current = true;
        router.refresh();
      }
      return;
    }
    unlockRefreshedRef.current = false;
  }, [liveD30, liveD90, server.rangeUnlocked.d30, server.rangeUnlocked.d90, router]);

  return {
    data: data ?? null,
    updatedAt,
    isPaused: isHidden,
    isStale: livePollIsStale(errorCount),
  };
}
