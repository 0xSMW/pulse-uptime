"use client";

export default function StatusError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-12 sm:px-6">
      <h1 className="text-base font-semibold">Status unavailable</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">We couldn’t load current status</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 h-10 rounded-md border border-[var(--border-strong)] px-3 text-sm font-medium hover:border-[var(--border-hover)] hover:bg-[var(--hover)]"
      >
        Try Again
      </button>
    </main>
  );
}
