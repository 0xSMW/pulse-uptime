// Pure connection-string validation for production migrations.
//
// Migrations use a single session-scoped client (advisory lock + DDL). Pooled
// endpoints and PgBouncer transaction mode break that contract, so reject them
// before any network call. Logs from callers must use only the sanitized
// hostname and database fields returned here.

/** @typedef {'invalid_url' | 'invalid_scheme' | 'missing_hostname' | 'missing_database' | 'pooler_hostname' | 'pooler_options'} MigrationUrlErrorCode */

/**
 * @typedef {object} ValidatedMigrationUrl
 * @property {true} ok
 * @property {URL} url
 * @property {string} hostname
 * @property {string} database
 * @property {string} connectionString
 */

/**
 * @typedef {object} MigrationUrlValidationError
 * @property {false} ok
 * @property {MigrationUrlErrorCode} code
 * @property {string} message
 */

const ALLOWED_SCHEMES = new Set(["postgres:", "postgresql:"])

const FALSEY_PARAM = new Set(["", "0", "false", "no", "off"])

/**
 * Neon pooler hosts put `-pooler` on the first DNS label
 * (for example `ep-cool-name-123456-pooler.region.aws.neon.tech`).
 * @param {string} hostname
 */
function isPoolerHostname(hostname) {
  const firstLabel = hostname.split(".")[0]?.toLowerCase() ?? ""
  if (!firstLabel) {
    return false
  }
  return firstLabel === "pooler" || firstLabel.endsWith("-pooler")
}

/**
 * Reject explicit PgBouncer or transaction/statement pooling options.
 * @param {URLSearchParams} searchParams
 */
function hasExplicitPoolerOptions(searchParams) {
  for (const [rawKey, rawValue] of searchParams.entries()) {
    const key = rawKey.toLowerCase()
    const value = rawValue.toLowerCase()

    if (key === "pgbouncer" && !FALSEY_PARAM.has(value)) {
      return true
    }

    if (
      key === "pool_mode" &&
      (value === "transaction" || value === "statement")
    ) {
      return true
    }

    if (
      key === "options" &&
      (/pgbouncer/i.test(rawValue) ||
        /pool_mode\s*=\s*(transaction|statement)/i.test(rawValue))
    ) {
      return true
    }
  }
  return false
}

/**
 * Database name is the first non-empty path segment (leading slash stripped).
 * @param {string} pathname
 */
function databaseNameFromPath(pathname) {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!trimmed) {
    return ""
  }
  return trimmed.split("/")[0] ?? ""
}

/**
 * Validate a direct (non-pooled) Postgres URL for migration use.
 *
 * @param {string} connectionString
 * @returns {ValidatedMigrationUrl | MigrationUrlValidationError}
 */
export function validateDirectMigrationUrl(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    return {
      ok: false,
      code: "invalid_url",
      message: "Connection string is empty or not a string",
    }
  }

  /** @type {URL} */
  let url
  try {
    url = new URL(connectionString)
  } catch {
    return {
      ok: false,
      code: "invalid_url",
      message: "Connection string is not a parseable URL",
    }
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      code: "invalid_scheme",
      message: `Scheme must be postgres: or postgresql: (got ${url.protocol || "none"})`,
    }
  }

  const hostname = url.hostname
  if (!hostname) {
    return {
      ok: false,
      code: "missing_hostname",
      message: "Hostname is missing or not parseable",
    }
  }

  const database = databaseNameFromPath(url.pathname)
  if (!database) {
    return {
      ok: false,
      code: "missing_database",
      message: "Database name is missing from the URL path",
    }
  }

  if (isPoolerHostname(hostname)) {
    return {
      ok: false,
      code: "pooler_hostname",
      message:
        "Hostname identifies a pooler endpoint. Use the direct (unpooled) host for migrations",
    }
  }

  if (hasExplicitPoolerOptions(url.searchParams)) {
    return {
      ok: false,
      code: "pooler_options",
      message:
        "Connection options request PgBouncer or transaction pooling. Use a direct session connection",
    }
  }

  return {
    ok: true,
    url,
    hostname,
    database,
    connectionString,
  }
}
