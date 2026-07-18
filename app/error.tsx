"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Pulse route failed", { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] items-center px-6">
      <Card className="w-full text-center">
        <h1 className="text-xl font-semibold">Pulse needs another try</h1>
        <p className="mt-2 text-[var(--fg-muted)]">Retry this request</p>
        <Button className="mt-6 w-full" onClick={reset}>
          Retry
        </Button>
      </Card>
    </main>
  );
}
