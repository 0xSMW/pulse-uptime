export function StatusUnavailable() {
  const pageName = process.env.NEXT_PUBLIC_STATUS_PAGE_NAME?.trim() || "System Status";

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-12 sm:px-6">
      <h1 className="text-base font-semibold tracking-[-0.32px]">{pageName}</h1>
      <div className="mt-6 rounded-xl border border-[var(--border-strong)] p-6">
        <h2 className="text-sm font-semibold">Status unavailable</h2>
        <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
          Status information is temporarily unavailable. Please check again shortly.
        </p>
      </div>
    </main>
  );
}
