"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

import { Button } from "@/components/ui/button";

export default function SettingsError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div role="alert" className="rounded-xl border border-[var(--border-strong)] p-6">
      <h2 className="text-base font-semibold">Settings unavailable</h2>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">Settings could not be loaded. Try again.</p>
      <Button variant="secondary" className="mt-4" onClick={retry}>Retry</Button>
    </div>
  );
}
