"use client";

import { useEffect, useState } from "react";

import { StatusDot, type MonitorState } from "@/components/monitors/status-dot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type Diagnosis = "checking" | "offline" | "server" | "database" | "transient";

const COPY: Record<Diagnosis, { title: string; body: string }> = {
  checking: {
    title: "Something went wrong",
    body: "Checking Pulse's own components to find out what happened.",
  },
  offline: {
    title: "You're offline",
    body: "Pulse can't be reached without a network connection. Reconnect, then retry.",
  },
  server: {
    title: "Pulse isn't responding",
    body: "The server didn't answer a health check. It may be restarting or mid-deploy. Retry in a moment.",
  },
  database: {
    title: "Pulse can't reach its database",
    body: "The app is running but its database isn't answering. Monitoring checks and alerts may be delayed until it recovers.",
  },
  transient: {
    title: "This page hit an error",
    body: "The rest of Pulse looks healthy, so the failure is isolated to this page. Retrying usually resolves it.",
  },
};

const DOT_STATE: Record<Diagnosis, MonitorState> = {
  checking: "VERIFYING_DOWN",
  offline: "PENDING",
  server: "DOWN",
  database: "DOWN",
  transient: "VERIFYING_DOWN",
};

async function diagnose(): Promise<Diagnosis> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return "server";
    const health = (await response.json()) as { database?: string };
    return health.database === "ok" ? "transient" : "database";
  } catch {
    return "server";
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis>("checking");

  useEffect(() => {
    console.error("Pulse route failed", { digest: error.digest });
  }, [error.digest]);

  // The boundary only receives an opaque digest in production, so the cause
  // shown to the user comes from probing the health endpoint, which runs
  // independently of the render that failed.
  useEffect(() => {
    let cancelled = false;
    diagnose().then((result) => {
      if (!cancelled) setDiagnosis(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = COPY[diagnosis];

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] items-center px-6">
      <Card className="w-full p-6">
        <div className="flex items-center gap-2.5">
          <StatusDot state={DOT_STATE[diagnosis]} aria-hidden />
          <h1 className="text-sm leading-5 font-semibold tracking-[-0.28px]">{copy.title}</h1>
        </div>
        <p aria-live="polite" className="mt-2 text-sm leading-5 text-[var(--fg-muted)]">
          {copy.body}
        </p>
        <div className="mt-5 flex items-center gap-2">
          <Button size="sm" onClick={reset}>
            Retry
          </Button>
          <Button size="sm" variant="tertiary" onClick={() => window.location.reload()}>
            Reload the app
          </Button>
        </div>
      </Card>
    </main>
  );
}
