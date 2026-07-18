import Link from "next/link";

export default function StatusNotFound() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-12 sm:px-6">
      <h1 className="text-base font-semibold">Group not found</h1>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        This public status group is unavailable
      </p>
      <Link
        href="/status"
        className="mt-6 inline-flex text-[13px] font-medium hover:underline"
      >
        ← All Systems
      </Link>
    </main>
  );
}
