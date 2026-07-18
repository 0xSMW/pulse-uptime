import {
  readinessSystems,
  type ReadinessProbe,
  type ReadinessReport,
  type ReadinessResult,
} from "./types";

const RESULT_TTL_MS = 60_000;

export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runReadinessChecks(
  probes: Record<(typeof readinessSystems)[number], ReadinessProbe>,
  now = new Date(),
): Promise<ReadinessReport> {
  const results = await Promise.all(
    readinessSystems.map(async (system): Promise<ReadinessResult> => {
      try {
        const result = await probes[system]();
        return { ...result, system };
      } catch {
        return failureFor(system);
      }
    }),
  );

  const blocked = results.some((result) => result.state === "blocked");
  const emailWarning = results.some(
    (result) => result.system === "email" && result.state === "warning",
  );

  return {
    checkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    canContinue: !blocked,
    requiresEmailAcknowledgement: !blocked && emailWarning,
    checks: results,
  };
}

function failureFor(system: (typeof readinessSystems)[number]): ReadinessResult {
  if (system === "email") {
    return {
      system,
      state: "warning",
      code: "EMAIL_UNAVAILABLE",
      remediation: "Verify your Resend sender",
    };
  }

  const remediation: Record<Exclude<typeof system, "email">, string> = {
    vercel: "Complete the Vercel environment setup",
    database: "Connect Neon and run migrations",
    edge: "Connect a writable Edge Config store",
  };

  return {
    system,
    state: "blocked",
    code: `${system.toUpperCase()}_UNAVAILABLE`,
    remediation: remediation[system],
  };
}
