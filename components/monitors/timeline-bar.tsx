import { cn } from "@/lib/utils";

export type TimelineBucket = {
  state: "up" | "down" | "verifying" | "paused" | "no-data";
  label: string;
  checks: number;
  failures: number;
  downtimeSeconds?: number;
};

const bucketClass: Record<TimelineBucket["state"], string> = {
  up: "bg-[var(--up)]",
  down: "bg-[var(--down)]",
  verifying: "bg-[var(--verifying)]",
  paused:
    "bg-[repeating-linear-gradient(135deg,var(--neutral-state)_0,var(--neutral-state)_1px,transparent_1px,transparent_3px)]",
  "no-data": "bg-[var(--chip-bg)]",
};

export function TimelineBar({
  buckets,
  height = 24,
  label,
  className,
}: {
  buckets: TimelineBucket[];
  height?: 24 | 32;
  label: string;
  className?: string;
}) {
  const summary = buckets.reduce(
    (result, bucket) => ({
      checks: result.checks + bucket.checks,
      failures: result.failures + bucket.failures,
    }),
    { checks: 0, failures: 0 },
  );

  return (
    <div
      role="img"
      aria-label={`${label}: ${summary.checks} checks, ${summary.failures} failed`}
      className={cn("flex w-full gap-0.5", className)}
      style={{ height }}
    >
      {buckets.map((bucket, index) => (
        <button
          key={`${bucket.label}-${index}`}
          type="button"
          className={cn(
            "min-w-0 flex-1 rounded-[1.5px] border-0 p-0",
            bucketClass[bucket.state],
          )}
          aria-label={`${bucket.label}: ${bucket.state}, ${bucket.checks} checks, ${bucket.failures} failed${
            bucket.downtimeSeconds ? `, ${bucket.downtimeSeconds} seconds down` : ""
          }`}
          title={`${bucket.label} · ${bucket.state} · ${bucket.checks} checks`}
        />
      ))}
    </div>
  );
}
