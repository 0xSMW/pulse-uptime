import "server-only"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { sourceFromPrincipalKey, trackEvent } from "@/lib/analytics-server"
import { runManualCheck } from "@/lib/checker"
import {
  createMonitorWithDefaults,
  displayName,
  type GroupConfig,
  hashCanonical,
  type MonitorConfig,
  monitorConfigSchema,
} from "@/lib/config"
import { type DatabaseHandle, db } from "@/lib/db/client"
import { monitorRegistry, monitorState } from "@/lib/db/schema"
import {
  domainHealthByMonitorId,
  type SerializedDomainHealthFacts,
} from "@/lib/domain-health/queries"
import { uptime24hByMonitorId } from "@/lib/monitoring/queries"
import { MONITOR_STATE_ORDER, type MonitorState } from "@/lib/monitoring/types"

import {
  applyConfigChange as applyConfigurationChange,
  ConfigMutationError,
  requireAcceptedConfig as loadConfigSnapshot,
  nextConfig,
} from "./config-mutation"
import { decodeCursor, encodeCursor } from "./pagination"

const idSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(3)
  .max(64)
const createSchemaBase = z
  .object({
    id: idSchema,
    name: displayName(1, 80),
    url: z.string(),
    enabled: z.boolean().optional(),
    group: displayName(1, 50).nullable().optional(),
    groupId: idSchema.nullable().optional(),
    method: z.enum(["GET", "HEAD"]).optional(),
    intervalMinutes: z
      .union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)])
      .optional(),
    timeoutMs: z.number().int().min(1000).max(15_000).optional(),
    expectedStatus: z
      .object({ minimum: z.number().int(), maximum: z.number().int() })
      .strict()
      .optional(),
    failureThreshold: z.number().int().min(1).max(5).optional(),
    recoveryThreshold: z.number().int().min(1).max(5).optional(),
    recipients: z.array(z.string()).max(20).optional(),
    // null clears the content check on PATCH; the stored config keeps the key
    // omitted rather than null so canonical hashes stay stable.
    expectedText: displayName(1, 256).nullable().optional(),
  })
  .strict()
const exclusiveGroup = (value: { group?: unknown; groupId?: unknown }) =>
  !(value.group !== undefined && value.groupId !== undefined)
const createSchema = createSchemaBase.refine(exclusiveGroup, {
  message: "Use either group or groupId",
  path: ["groupId"],
})

const patchSchema = createSchemaBase
  .omit({ id: true })
  .partial()
  .refine(exclusiveGroup, {
    message: "Use either group or groupId",
    path: ["groupId"],
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one monitor field is required",
  })

export class MonitorApiError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "MONITOR_NOT_FOUND"
      | "MONITOR_EXISTS"
      | "GROUP_NOT_FOUND"
      | "CONFIGURATION_UNAVAILABLE"
      | "EDGE_CONFIG_UNAVAILABLE",
    message: string
  ) {
    super(message)
    this.name = "MonitorApiError"
  }
}

function translateConfigError(error: unknown): never {
  if (error instanceof ConfigMutationError) {
    throw new MonitorApiError(error.code, error.message)
  }
  throw error
}

async function requireAcceptedConfig() {
  try {
    return await loadConfigSnapshot()
  } catch (error) {
    return translateConfigError(error)
  }
}

async function applyConfigChange(
  ...args: Parameters<typeof applyConfigurationChange>
) {
  try {
    return await applyConfigurationChange(...args)
  } catch (error) {
    return translateConfigError(error)
  }
}

function resolveGroupId(
  value: { group?: string | null; groupId?: string | null },
  groups: readonly GroupConfig[]
): string | null {
  if (value.groupId !== undefined) {
    return value.groupId
  }
  if (value.group === undefined || value.group === null) {
    return null
  }
  const groupId = groups.find(
    (group) =>
      group.name.toLocaleLowerCase("en-US") ===
      value.group!.trim().toLocaleLowerCase("en-US")
  )?.id
  if (!groupId) {
    throw new MonitorApiError("GROUP_NOT_FOUND", "Group was not found")
  }
  return groupId
}

function withoutClearedExpectedText<T extends { expectedText?: string | null }>(
  fields: T
): Omit<T, "expectedText"> & { expectedText?: string } {
  const { expectedText, ...rest } = fields
  return expectedText === null || expectedText === undefined
    ? rest
    : { ...rest, expectedText }
}

export function parseCreateMonitor(
  input: unknown,
  groups: readonly GroupConfig[] = []
): MonitorConfig {
  const value = createSchema.parse(input)
  const fields = withoutClearedExpectedText({ ...value })
  delete fields.group
  return monitorConfigSchema.parse({
    ...createMonitorWithDefaults(fields),
    ...fields,
    groupId: resolveGroupId(value, groups),
  })
}

export function parsePatchMonitor(input: unknown): z.infer<typeof patchSchema> {
  return patchSchema.parse(input)
}

export function mergeMonitorPatch(
  monitor: MonitorConfig,
  patch: z.infer<typeof patchSchema>
): MonitorConfig {
  const fields = { ...patch }
  delete fields.group
  const merged: Record<string, unknown> = {
    ...monitor,
    ...fields,
    expectedStatus: patch.expectedStatus ?? monitor.expectedStatus,
  }
  // expectedText: null clears the check, undefined leaves it alone, and the
  // merged config never stores the key as null.
  if (patch.expectedText === null) {
    delete merged.expectedText
  }
  if (merged.expectedText === undefined) {
    delete merged.expectedText
  }
  return monitorConfigSchema.parse(merged)
}

function monitorResponse(
  monitor: MonitorConfig,
  groups: readonly GroupConfig[]
) {
  return {
    ...monitor,
    group: monitor.groupId
      ? (groups.find((group) => group.id === monitor.groupId)?.name ?? null)
      : null,
  }
}

export async function createMonitor(
  input: unknown,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  let created!: MonitorConfig
  let inserted = false
  const result = await applyConfigChange(
    principalKey,
    (current) => {
      const monitor = parseCreateMonitor(input, current.groups)
      created = monitor
      const existing = current.monitors.find((item) => item.id === monitor.id)
      if (existing) {
        if (hashCanonical(existing) === hashCanonical(monitor)) {
          return current
        }
        throw new MonitorApiError(
          "MONITOR_EXISTS",
          "A monitor with this ID already exists"
        )
      }
      inserted = true
      return nextConfig(current, {
        monitors: [...current.monitors, monitor],
      })
    },
    handle
  )
  if (inserted) {
    trackEvent("Monitor Created", {
      contentCheck: created.expectedText !== undefined,
      source: sourceFromPrincipalKey(principalKey),
    })
  }
  return monitorResponse(
    result.monitors.find((item) => item.id === created.id)!,
    result.groups
  )
}

export async function updateMonitor(
  id: string,
  input: unknown,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  const patch = parsePatchMonitor(input)
  const result = await applyConfigChange(
    principalKey,
    (current) => {
      const existing = current.monitors.find((item) => item.id === id)
      if (!existing) {
        throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
      }
      const nextPatch =
        patch.group !== undefined || patch.groupId !== undefined
          ? { ...patch, groupId: resolveGroupId(patch, current.groups) }
          : patch
      return nextConfig(current, {
        monitors: current.monitors.map((item) =>
          item.id === id ? mergeMonitorPatch(item, nextPatch) : item
        ),
      })
    },
    handle
  )
  return monitorResponse(
    result.monitors.find((item) => item.id === id)!,
    result.groups
  )
}

export async function archiveMonitor(
  id: string,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  try {
    await applyConfigChange(
      principalKey,
      (current) => {
        if (!current.monitors.some((item) => item.id === id)) {
          throw new MonitorApiError(
            "MONITOR_NOT_FOUND",
            "Monitor was not found"
          )
        }
        return nextConfig(current, {
          monitors: current.monitors.filter((item) => item.id !== id),
        })
      },
      handle
    )
    trackEvent("Monitor Deleted", {
      source: sourceFromPrincipalKey(principalKey),
    })
  } catch (error) {
    if (
      !(error instanceof MonitorApiError) ||
      error.code !== "MONITOR_NOT_FOUND"
    ) {
      throw error
    }
    const [archived] = await handle
      .select({ id: monitorRegistry.id })
      .from(monitorRegistry)
      .where(
        and(
          eq(monitorRegistry.id, id),
          drizzleSql`${monitorRegistry.archivedAt} is not null`
        )
      )
      .limit(1)
    if (!archived) {
      throw error
    }
  }
  return { id, archived: true }
}

export async function setMonitorEnabled(
  id: string,
  enabled: boolean,
  principalKey: string,
  handle: DatabaseHandle = db
) {
  const result = await applyConfigChange(
    principalKey,
    (current) => {
      if (!current.monitors.some((item) => item.id === id)) {
        throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
      }
      return nextConfig(current, {
        monitors: current.monitors.map((item) =>
          item.id === id ? { ...item, enabled } : item
        ),
      })
    },
    handle
  )
  return monitorResponse(
    result.monitors.find((item) => item.id === id)!,
    result.groups
  )
}

interface DomainHealthFacts {
  certExpiresAt: string | null
  certIssuer: string | null
  domainExpiresAt: string | null
  domainRegistrar: string | null
}

const EMPTY_DOMAIN_HEALTH: DomainHealthFacts = {
  certExpiresAt: null,
  certIssuer: null,
  domainExpiresAt: null,
  domainRegistrar: null,
}

function apiDomainHealth(
  facts: SerializedDomainHealthFacts | undefined
): DomainHealthFacts {
  if (!facts) {
    return EMPTY_DOMAIN_HEALTH
  }
  return {
    certExpiresAt: facts.certExpiresAt,
    certIssuer: facts.certIssuer,
    domainExpiresAt: facts.domainExpiresAt,
    domainRegistrar: facts.domainRegistrar,
  }
}

export async function requireMonitor(id: string, handle: DatabaseHandle = db) {
  const accepted = await requireAcceptedConfig()
  const monitor = accepted.config.monitors.find((item) => item.id === id)
  if (!monitor) {
    throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
  }
  // The single get carries the same runtime fields list items had before uptime:
  // state from the state table plus createdAt and updatedAt from the registry and
  // state rows. uptime stays list only. A monitor with no registry row yet reads
  // the config shape alone.
  const [[runtime], health] = await Promise.all([
    handle
      .select({
        state: monitorState.state,
        createdAt: monitorRegistry.firstSeenAt,
        updatedAt: monitorState.updatedAt,
      })
      .from(monitorState)
      .innerJoin(
        monitorRegistry,
        eq(monitorRegistry.id, monitorState.monitorId)
      )
      .where(eq(monitorState.monitorId, id)),
    domainHealthByMonitorId([{ id: monitor.id, url: monitor.url }], handle),
  ])
  const base = {
    ...monitorResponse(monitor, accepted.config.groups),
    ...apiDomainHealth(health.get(id)),
  }
  return runtime
    ? {
        ...base,
        state: runtime.state,
        createdAt: runtime.createdAt.toISOString(),
        updatedAt: runtime.updatedAt.toISOString(),
      }
    : base
}

export async function listMonitors(options: {
  cursor: string | null
  limit: number
  state?: MonitorState
  group?: string
  groupId?: string
  enabled?: boolean
  sort?: "state" | "name" | "id"
}) {
  const cursor = decodeCursor(options.cursor)
  const sort = options.sort ?? "state"
  const fingerprint = JSON.stringify({
    state: options.state ?? null,
    group: options.group ?? null,
    groupId: options.groupId ?? null,
    enabled: options.enabled ?? null,
    sort,
  })
  if (options.cursor && !cursor) {
    throw new MonitorApiError("INVALID_REQUEST", "Cursor is invalid")
  }
  const accepted = await requireAcceptedConfig()
  const ids = accepted.config.monitors.map((monitor) => monitor.id)
  const states = ids.length
    ? await db
        .select({
          id: monitorState.monitorId,
          state: monitorState.state,
          createdAt: monitorRegistry.firstSeenAt,
          updatedAt: monitorState.updatedAt,
        })
        .from(monitorState)
        .innerJoin(
          monitorRegistry,
          eq(monitorRegistry.id, monitorState.monitorId)
        )
        .where(inArray(monitorState.monitorId, ids))
    : []
  const stateById = new Map(states.map((row) => [row.id, row]))
  const groupNames = new Map(
    accepted.config.groups.map((group) => [group.id, group.name])
  )
  const filtered = accepted.config.monitors
    .map((monitor) => {
      const runtime = stateById.get(monitor.id)
      return {
        ...monitor,
        group: monitor.groupId
          ? (groupNames.get(monitor.groupId) ?? null)
          : null,
        ...(runtime
          ? {
              state: runtime.state,
              createdAt: runtime.createdAt.toISOString(),
              updatedAt: runtime.updatedAt.toISOString(),
            }
          : {}),
      }
    })
    .filter(
      (monitor) =>
        options.state === undefined || monitor.state === options.state
    )
    .filter(
      (monitor) =>
        options.group === undefined ||
        monitor.group?.toLocaleLowerCase("en-US") ===
          options.group.toLocaleLowerCase("en-US")
    )
    .filter(
      (monitor) =>
        options.groupId === undefined || monitor.groupId === options.groupId
    )
    .filter(
      (monitor) =>
        options.enabled === undefined || monitor.enabled === options.enabled
    )
  const keyFor = (monitor: (typeof filtered)[number]) =>
    sort === "name"
      ? monitor.name.toLocaleLowerCase("en-US")
      : sort === "id"
        ? monitor.id
        : String(
            MONITOR_STATE_ORDER.indexOf(
              (monitor.state ?? "PENDING") as MonitorState
            )
          ).padStart(2, "0") +
          "\0" +
          monitor.name.toLocaleLowerCase("en-US")
  const compareText = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0
  const sorted = filtered.sort(
    (a, b) => compareText(keyFor(a), keyFor(b)) || compareText(a.id, b.id)
  )
  let after = sorted
  if (cursor) {
    const separator = cursor.sort.indexOf("\0")
    if (separator < 0 || cursor.sort.slice(0, separator) !== fingerprint) {
      throw new MonitorApiError(
        "INVALID_REQUEST",
        "Cursor is invalid for these filters"
      )
    }
    const cursorKey = cursor.sort.slice(separator + 1)
    after = sorted.filter(
      (monitor) =>
        compareText(keyFor(monitor), cursorKey) > 0 ||
        (keyFor(monitor) === cursorKey &&
          compareText(monitor.id, cursor.id) > 0)
    )
  }
  const page = after.slice(0, options.limit)
  const last = page.at(-1)
  const next =
    after.length > page.length && last
      ? encodeCursor({ sort: `${fingerprint}\0${keyFor(last)}`, id: last.id })
      : null
  // uptime and observedUptime are the reporting-owned fields on the list
  // payload, computed for the returned page only. uptime is the settled 24h
  // figure, null while locked or without a registry row. observedUptime is
  // the since-activation figure a collecting monitor shows in its place.
  const [uptime, health] = await Promise.all([
    uptime24hByMonitorId(page.map((monitor) => monitor.id)),
    domainHealthByMonitorId(
      page.map((monitor) => ({ id: monitor.id, url: monitor.url }))
    ),
  ])
  return {
    monitors: page.map((monitor) => {
      const entry = uptime.get(monitor.id)
      return {
        ...monitor,
        uptime: entry?.uptime24h ?? null,
        observedUptime: entry?.observedUptime ?? null,
        ...apiDomainHealth(health.get(monitor.id)),
      }
    }),
    nextCursor: next,
  }
}

export async function testMonitor(id: string) {
  const accepted = await requireAcceptedConfig()
  const monitor = accepted.config.monitors.find((item) => item.id === id)
  if (!monitor) {
    throw new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found")
  }
  const result = await runManualCheck(monitor.url, {
    method: monitor.method,
    timeoutMs: monitor.timeoutMs,
    expectedStatus: monitor.expectedStatus,
    expectedText: monitor.expectedText,
    userAgent: accepted.config.settings.userAgent,
  })
  return {
    successful: result.success,
    method: result.method,
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    redirectCount: result.redirectCount,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  }
}
