import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import { type DatabaseHandle, db } from "@/lib/db/client"
import { adminUsers, images, statusPageConfig } from "@/lib/db/schema"
import {
  DEFAULT_STATUS_PAGE_NAME,
  parseStatusPageConfigDocument,
  type StatusPageConfigDocument,
  type StatusPageNavLink,
} from "@/lib/status-page/schema"

/**
 * Store-injection service for the dedicated single-row status page
 * configuration. Writes are optimistic-concurrency guarded: every PUT
 * carries the ETag captured on read, derived from a monotonic `version`
 * counter, never from updatedAt. Two writes landing in the same millisecond
 * must still produce distinct ETags, or a client holding the pre-write
 * If-Match could pass the precondition after another save and clobber it.
 * `version` increments by exactly 1 on every successful write, and the
 * conditional UPDATE compares If-Match against the CURRENT version, so a
 * stale If-Match still 412s even within the same millisecond.
 *
 * Name seeding mechanic: the migration seeds row 1 with name NULL and
 * updatedAt NULL (version 0). The read path coalesces NULL name to
 * NEXT_PUBLIC_STATUS_PAGE_NAME (trimmed) and then falls back to the runtime
 * literal "Pulse Status" (DEFAULT_STATUS_PAGE_NAME),
 * and never persists the coalesced value. The first
 * successful PUT is the first write, so env-configured deployments keep their
 * title with no magic markers. Version 0 (the seed/unwritten state) still
 * produces the "0" ETag.
 */

export type StatusPageConfigData = StatusPageConfigDocument & {
  updatedAt: string | null
  version: number
}

export class StatusPageConfigError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIG"
      | "IMAGE_REFERENCE_INVALID"
      | "PRECONDITION_FAILED"
      | "CONFIG_UNAVAILABLE",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "StatusPageConfigError"
  }
}

/** Quoted version counter. `"0"` marks the never-updated seed row. */
export function statusPageConfigEtag(version: number): string {
  return `"${version}"`
}

/**
 * Opaque-tag of an ETag with the weak-validator prefix stripped. Our ETag is a
 * strong quoted version counter, but a compression or CDN layer in front of the
 * route can re-emit it in weak form (`W/"1"`) because the transferred bytes
 * changed. A client that records the response ETag verbatim (the CLI export
 * writes it into _etag, apply sends it back in If-Match) then presents that weak
 * form, which a byte-for-byte precondition check would never match. Comparing on
 * the opaque tag alone lets an untouched export apply cleanly, following the weak
 * comparison function of RFC 9110 section 8.8.3.2.
 */
function etagOpaqueTag(etag: string): string {
  const trimmed = etag.trim()
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed
}

/** True when two ETags identify the same representation under weak comparison. */
function statusPageConfigEtagMatches(
  current: string,
  ifMatch: string
): boolean {
  return etagOpaqueTag(current) === etagOpaqueTag(ifMatch)
}

type StatusPageConfigRow = StatusPageConfigDocument & {
  updatedAt: Date | null
  version: number
}

export interface StatusPageConfigStore {
  read: () => Promise<
    (Omit<StatusPageConfigRow, "name"> & { name: string | null }) | null
  >
  /** Conditional single-row update, false when version no longer matches expectedVersion. */
  write: (input: {
    document: StatusPageConfigDocument
    expectedVersion: number
    now: Date
  }) => Promise<boolean>
  findImageKinds: (
    ids: readonly string[]
  ) => Promise<Array<{ id: string; kind: string }>>
  /** Deletes the given image rows unless something still references them. */
  deleteUnreferencedImages: (ids: readonly string[]) => Promise<number>
}

export interface StatusPageConfigDependencies {
  store?: StatusPageConfigStore
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Runs the store against this handle instead of the default pool, so the guarded update can join an outer transaction as a savepoint. Ignored when `store` is given. */
  handle?: DatabaseHandle
}

function defaultName(env: Record<string, string | undefined>): string {
  return env.NEXT_PUBLIC_STATUS_PAGE_NAME?.trim() || DEFAULT_STATUS_PAGE_NAME
}

function present(
  row: Omit<StatusPageConfigRow, "name"> & { name: string | null },
  env: Record<string, string | undefined>
): StatusPageConfigData {
  const { updatedAt, ...document } = row
  return {
    ...document,
    name: row.name ?? defaultName(env),
    updatedAt: updatedAt?.toISOString() ?? null,
  }
}

export async function getStatusPageConfig(
  dependencies: StatusPageConfigDependencies = {}
): Promise<{ data: StatusPageConfigData; etag: string }> {
  const store = dependencies.store ?? databaseStatusPageConfigStore
  const row = await store.read()
  if (!row) {
    throw new StatusPageConfigError(
      "CONFIG_UNAVAILABLE",
      "The status page configuration row is missing; run database migrations"
    )
  }
  return {
    data: present(row, dependencies.env ?? process.env),
    etag: statusPageConfigEtag(row.version),
  }
}

const IMAGE_REFERENCE_FIELDS = [
  ["logoLightImageId", "logo-light"],
  ["logoDarkImageId", "logo-dark"],
  ["faviconImageId", "favicon"],
] as const

export async function putStatusPageConfig(
  input: unknown,
  ifMatchEtag: string,
  dependencies: StatusPageConfigDependencies = {}
): Promise<{ data: StatusPageConfigData; etag: string }> {
  const parsed = parseStatusPageConfigDocument(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new StatusPageConfigError(
      "INVALID_CONFIG",
      `Invalid status page configuration${at}: ${issue?.message ?? "invalid document"}`,
      {
        issues: parsed.error.issues.map((entry) => ({
          path: entry.path.join("."),
          message: entry.message,
        })),
      }
    )
  }
  const document = parsed.data

  const store =
    dependencies.store ??
    createDatabaseStatusPageConfigStore(dependencies.handle)
  const current = await store.read()
  if (!current) {
    throw new StatusPageConfigError(
      "CONFIG_UNAVAILABLE",
      "The status page configuration row is missing; run database migrations"
    )
  }
  if (
    !statusPageConfigEtagMatches(
      statusPageConfigEtag(current.version),
      ifMatchEtag
    )
  ) {
    throw new StatusPageConfigError(
      "PRECONDITION_FAILED",
      "The status page configuration changed since it was read"
    )
  }

  const references = IMAGE_REFERENCE_FIELDS.map(([field, kind]) => ({
    field,
    kind,
    id: document[field],
  })).filter(
    (reference): reference is typeof reference & { id: string } =>
      reference.id !== null
  )
  if (references.length > 0) {
    const found = new Map(
      (await store.findImageKinds(references.map(({ id }) => id))).map(
        (row) => [row.id, row.kind]
      )
    )
    for (const { field, kind, id } of references) {
      if (found.get(id) !== kind) {
        throw new StatusPageConfigError(
          "IMAGE_REFERENCE_INVALID",
          `${field} must reference an uploaded ${kind} image`,
          { field }
        )
      }
    }
  }

  const now = dependencies.now?.() ?? new Date()
  const nextVersion = current.version + 1
  const written = await store.write({
    document,
    expectedVersion: current.version,
    now,
  })
  if (!written) {
    throw new StatusPageConfigError(
      "PRECONDITION_FAILED",
      "The status page configuration changed since it was read"
    )
  }

  // Explicit GC: image rows the previous document referenced but the new one
  // does not are deleted, unless something else (including an admin avatar
  // column) still points at them. Failures leave orphans for the sweep.
  const nextIds = new Set(references.map(({ id }) => id))
  const removed = [
    ...new Set(
      IMAGE_REFERENCE_FIELDS.map(([field]) => current[field]).filter(
        (id): id is string => id !== null && !nextIds.has(id)
      )
    ),
  ]
  if (removed.length > 0) {
    await store.deleteUnreferencedImages(removed).catch(() => 0)
  }

  return {
    data: present(
      { ...document, updatedAt: now, version: nextVersion },
      dependencies.env ?? process.env
    ),
    etag: statusPageConfigEtag(nextVersion),
  }
}

const configSelection = {
  name: statusPageConfig.name,
  layout: statusPageConfig.layout,
  theme: statusPageConfig.theme,
  logoLightImageId: statusPageConfig.logoLightImageId,
  logoDarkImageId: statusPageConfig.logoDarkImageId,
  faviconImageId: statusPageConfig.faviconImageId,
  homepageUrl: statusPageConfig.homepageUrl,
  contactUrl: statusPageConfig.contactUrl,
  navLinks: statusPageConfig.navLinks,
  googleTagId: statusPageConfig.googleTagId,
  customCss: statusPageConfig.customCss,
  customHead: statusPageConfig.customHead,
  announcementEnabled: statusPageConfig.announcementEnabled,
  announcementMarkdown: statusPageConfig.announcementMarkdown,
  historyDays: statusPageConfig.historyDays,
  uptimeDecimals: statusPageConfig.uptimeDecimals,
  unknownAsOperational: statusPageConfig.unknownAsOperational,
  minIncidentSeconds: statusPageConfig.minIncidentSeconds,
  timezone: statusPageConfig.timezone,
  updatedAt: statusPageConfig.updatedAt,
  version: statusPageConfig.version,
}

/** Binds the store to `handle` (default the pool) so a caller can join an outer transaction as a savepoint. */
function createDatabaseStatusPageConfigStore(
  handle: DatabaseHandle = db
): StatusPageConfigStore {
  return {
    async read() {
      const [row] = await handle
        .select(configSelection)
        .from(statusPageConfig)
        .where(eq(statusPageConfig.id, 1))
        .limit(1)
      if (!row) {
        return null
      }
      return {
        ...row,
        historyDays: row.historyDays as 30 | 60 | 90,
        navLinks: (row.navLinks ?? []) as StatusPageNavLink[],
      }
    },
    // The conditional UPDATE compares against the CURRENT version (not
    // updatedAt), incrementing it in the same statement, so a stale If-Match
    // still fails even when two writes land in the same millisecond. The seed
    // row's version defaults to 0, so no separate "never written" branch is
    // needed: version 0 is a normal, comparable value.
    async write({ document, expectedVersion, now }) {
      const rows = await handle
        .update(statusPageConfig)
        .set({
          ...document,
          updatedAt: now,
          version: sql`${statusPageConfig.version} + 1`,
        })
        .where(
          and(
            eq(statusPageConfig.id, 1),
            eq(statusPageConfig.version, expectedVersion)
          )
        )
        .returning({ id: statusPageConfig.id })
      return rows.length > 0
    },
    async findImageKinds(ids) {
      if (ids.length === 0) {
        return []
      }
      return handle
        .select({ id: images.id, kind: images.kind })
        .from(images)
        .where(inArray(images.id, [...ids]))
    },
    async deleteUnreferencedImages(ids) {
      if (ids.length === 0) {
        return 0
      }
      // Runs as a savepoint of `handle`, never a bare statement on it: the
      // caller treats this delete as best-effort (see putStatusPageConfig's
      // .catch), but `handle` may already be the caller's outer transaction,
      // where an unguarded DB error would abort that whole transaction. The
      // swallowed rejection would then let execution continue into the
      // completion write, which dies with 25P02 and rolls back the config
      // write this GC is only ever supposed to run alongside.
      return handle.transaction(async (tx) => {
        const rows = await tx
          .delete(images)
          .where(
            and(
              inArray(images.id, [...ids]),
              sql`not exists (
              select 1 from ${statusPageConfig}
              where ${statusPageConfig.logoLightImageId} = ${images.id}
                or ${statusPageConfig.logoDarkImageId} = ${images.id}
                or ${statusPageConfig.faviconImageId} = ${images.id}
            )`,
              sql`not exists (select 1 from ${adminUsers} where ${adminUsers.avatarImageId} = ${images.id})`
            )
          )
          .returning({ id: images.id })
        return rows.length
      })
    },
  }
}

const databaseStatusPageConfigStore: StatusPageConfigStore =
  createDatabaseStatusPageConfigStore()
