/**
 * Classifies infra-class database errors: the ones a PUBLIC status surface
 * should degrade on instead of throwing, versus everything else (syntax
 * errors, constraint violations, app bugs), which must keep surfacing loudly.
 *
 * Three buckets, by `error.code` (walking the `cause` chain, since
 * postgres.js and Node's net/dns layers sometimes wrap the original error):
 *
 * 1. Connection failures: raw Node network errors bubbled through by
 *    postgres.js's socket handling, plus its own `connect_timeout` option:
 *    ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN, ETIMEDOUT.
 * 2. Postgres.js "write CONNECTION_*" connection-lifecycle errors (thrown via
 *    its internal `Errors.connection(...)` helper, surfaced as
 *    `new Error("write " + code + " ...")` with `error.code` set to the same
 *    token): CONNECT_TIMEOUT, CONNECTION_CLOSED, CONNECTION_DESTROYED,
 *    CONNECTION_ENDED (matched by exact code or a "CONNECTION_" prefix, so
 *    future variants from the same helper are covered too).
 * 3. Postgres SQLSTATE codes surfaced as `error.code` on a `PostgresError`:
 *    - 28P01 invalid_password, 28000 invalid_authorization_specification
 *      (auth failures)
 *    - 42P01 undefined_table, 42703 undefined_column (unapplied migrations)
 *
 * Anything else, including a plain `TypeError`/app bug, or a Postgres error
 * with a different SQLSTATE (constraint violation, syntax error, etc.), is
 * NOT classified as unavailable, so callers must rethrow it.
 */

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

const POSTGRES_JS_CONNECTION_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
]);

const POSTGRES_SQLSTATE_CODES = new Set([
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "42P01", // undefined_table (unapplied migrations)
  "42703", // undefined_column (unapplied migrations)
]);

function isUnavailableCode(code: unknown): boolean {
  if (typeof code !== "string" || code.length === 0) return false;
  return (
    CONNECTION_ERROR_CODES.has(code) ||
    POSTGRES_JS_CONNECTION_CODES.has(code) ||
    POSTGRES_SQLSTATE_CODES.has(code) ||
    code.startsWith("CONNECTION_")
  );
}

function codesOf(error: object): unknown[] {
  const codes: unknown[] = [(error as { code?: unknown }).code];
  // AggregateError (Node's happy-eyeballs dual-stack connect failures) nests
  // the individual attempts under `.errors` rather than `.cause`.
  const aggregate = (error as { errors?: unknown }).errors;
  if (Array.isArray(aggregate)) {
    for (const inner of aggregate) {
      if (inner && typeof inner === "object") codes.push((inner as { code?: unknown }).code);
    }
  }
  return codes;
}

/** True only for the infra-class errors described above; everything else should be rethrown. */
export function isDatabaseUnavailableError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (codesOf(current).some(isUnavailableCode)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
