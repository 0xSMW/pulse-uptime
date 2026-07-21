// Release-bound deploy proof canary.
// Polls GET /api/cron/deploy-proof?after=<promotion-boundary> until the live
// production deployment reports a completed monitor-check for its own
// PULSE_RELEASE_ID with completedAt >= the boundary. Extracted from YAML so
// the polling and acceptance rules are unit-testable.

/**
 * @typedef {object} VerifyDeployProofOptions
 * @property {string} baseUrl Production origin, no trailing path
 * @property {string} cronSecret Bearer secret for cron routes
 * @property {string} after ISO-8601 promotion boundary
 * @property {string} [expectedReleaseId] When set, response releaseId must match
 * @property {number} [maxAttempts]
 * @property {number} [sleepSeconds]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(msg: string) => void} [log]
 * @property {(msg: string) => void} [error]
 */

/**
 * @param {VerifyDeployProofOptions} options
 * @returns {Promise<{ ok: true, releaseId: string, runId: string, completedAt: string } | { ok: false, reason: string }>}
 */
export async function verifyDeployProof(options) {
  const {
    baseUrl,
    cronSecret,
    after,
    expectedReleaseId,
    maxAttempts = 20,
    sleepSeconds = 6,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
    error = console.error,
  } = options;

  if (!baseUrl || !cronSecret || !after) {
    return { ok: false, reason: "baseUrl, cronSecret, and after are required" };
  }

  const boundaryMs = Date.parse(after);
  if (Number.isNaN(boundaryMs)) {
    return { ok: false, reason: `after is not a valid ISO timestamp: ${after}` };
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/cron/deploy-proof?after=${encodeURIComponent(after)}`;
  let last = "no attempts";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let code = "000";
    let body = /** @type {Record<string, unknown> | null} */ (null);
    try {
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${cronSecret}`,
          accept: "application/json",
        },
      });
      code = String(response.status);
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    } catch (err) {
      last = `fetch error: ${err instanceof Error ? err.message : String(err)}`;
      log(`attempt ${attempt}/${maxAttempts} -> ${last}`);
      if (attempt < maxAttempts) await sleep(sleepSeconds * 1000);
      continue;
    }

    const status = body && typeof body.status === "string" ? body.status : "none";
    const releaseId = body && typeof body.releaseId === "string" ? body.releaseId : null;
    last = `http=${code} status=${status} releaseId=${releaseId ?? "none"}`;
    log(`attempt ${attempt}/${maxAttempts} -> ${last}`);

    if (code === "500" || status === "misconfigured") {
      return {
        ok: false,
        reason: `deploy-proof misconfigured (${last})`,
      };
    }

    if (code === "400" || status === "invalid_request") {
      return {
        ok: false,
        reason: `deploy-proof invalid_request (${last})`,
      };
    }

    if (code === "401") {
      return { ok: false, reason: "deploy-proof returned 401 unauthorized" };
    }

    if (expectedReleaseId && releaseId && releaseId !== expectedReleaseId) {
      return {
        ok: false,
        reason: `release id mismatch: expected ${expectedReleaseId}, got ${releaseId}`,
      };
    }

    if (code === "200" && status === "ready" && releaseId) {
      const completedAt = body && typeof body.completedAt === "string" ? body.completedAt : null;
      const runId = body && typeof body.runId === "string" ? body.runId : null;
      if (!completedAt || !runId) {
        return { ok: false, reason: `ready response missing run fields (${last})` };
      }
      const completedMs = Date.parse(completedAt);
      if (Number.isNaN(completedMs) || completedMs < boundaryMs) {
        return {
          ok: false,
          reason: `completedAt ${completedAt} is before promotion boundary ${after}`,
        };
      }
      if (expectedReleaseId && releaseId !== expectedReleaseId) {
        return {
          ok: false,
          reason: `release id mismatch: expected ${expectedReleaseId}, got ${releaseId}`,
        };
      }
      log(`deploy proof ready releaseId=${releaseId} runId=${runId} completedAt=${completedAt}`);
      return { ok: true, releaseId, runId, completedAt };
    }

    // 202 waiting and transient non-200 retry
    if (attempt < maxAttempts) await sleep(sleepSeconds * 1000);
  }

  const reason = `deploy-proof never reported ready (last ${last})`;
  error(reason);
  return { ok: false, reason };
}

/**
 * CLI entry used by the GitHub Actions canary.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ verify?: typeof verifyDeployProof, exit?: (code: number) => void }} [hooks]
 */
export async function main(env = process.env, hooks = {}) {
  const verify = hooks.verify ?? verifyDeployProof;
  const exit = hooks.exit ?? ((code) => process.exit(code));

  const result = await verify({
    baseUrl: env.BASE_URL ?? env.PRODUCTION_URL ?? "",
    cronSecret: env.CRON_SECRET ?? "",
    after: env.AFTER ?? "",
    expectedReleaseId: env.EXPECTED_RELEASE_ID || undefined,
    maxAttempts: env.MAX_ATTEMPTS ? Number(env.MAX_ATTEMPTS) : undefined,
    sleepSeconds: env.SLEEP_SECONDS ? Number(env.SLEEP_SECONDS) : undefined,
  });

  if (!result.ok) {
    console.error(`::error::Deploy proof failed: ${result.reason}`);
    exit(1);
    return 1;
  }
  console.log(`Deploy proof passed for release ${result.releaseId}`);
  exit(0);
  return 0;
}

const isDirect = process.argv[1] && (
  process.argv[1].endsWith("verify-deploy-proof.mjs")
  || process.argv[1].includes("verify-deploy-proof")
);

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
