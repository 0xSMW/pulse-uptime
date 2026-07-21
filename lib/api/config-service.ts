import "server-only"

import { eq, sql } from "drizzle-orm"

import {
  type AcceptedConfigSnapshot,
  ConfigApplyError,
  type ConfigurationApplyRequest,
  type ConfigurationPlan,
  createConfigurationPlan,
  type DeclarativeConfig,
  exportDeclarativeConfig,
  type MonitoringConfig,
  toMonitoringConfig,
  validateApplyPreconditions,
  validateDeclarativeConfig,
} from "@/lib/config"
import { findAcceptedSnapshot } from "@/lib/config/accepted-config"
import { writeMonitoringEdgeConfig } from "@/lib/config/edge-config-write"
import { db } from "@/lib/db/client"
import { configChangeApprovals, configOperations } from "@/lib/db/schema"

import { lockConfiguration as acquireConfigurationLock } from "./configuration-lock"

export const CONFIG_OPERATION_RETENTION_SECONDS = 7 * 24 * 60 * 60

interface ConfigOperation {
  id: string
  baseConfigHash: string
  targetConfigHash: string
  planHash: string
  state: "written" | "accepted" | "rejected" | "failed"
  edgeConfigVersion: number | null
  rejectionReason: string | null
  createdAt: string
  writtenAt: string | null
  acceptedAt: string | null
  failedAt: string | null
}

class ConfigurationServiceError extends Error {
  constructor(
    readonly code:
      | "CONFIG_NOT_INITIALIZED"
      | "CONFIG_VERSION_CONFLICT"
      | "EDGE_CONFIG_WRITE_FAILED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ConfigurationServiceError"
  }
}

export type EdgeConfigWriter = (
  config: MonitoringConfig
) => Promise<{ version: number | null }>

type OperationInsert = Omit<typeof configOperations.$inferInsert, "id"> & {
  id?: string
}
type ApprovalInsert = typeof configChangeApprovals.$inferInsert
export interface ConfigurationStore {
  readAccepted: () => Promise<AcceptedConfigSnapshot | null>
  transaction: <T>(
    work: (tx: {
      lockConfiguration: () => Promise<void>
      readAccepted: () => Promise<AcceptedConfigSnapshot | null>
      findOperation: (
        principalKey: string,
        idempotencyKey: string
      ) => Promise<ConfigOperation | null>
      insertApproval: (value: ApprovalInsert) => Promise<void>
      insertOperation: (value: OperationInsert) => Promise<ConfigOperation>
    }) => Promise<T>
  ) => Promise<T>
  readOperation: (id: string) => Promise<ConfigOperation | null>
}

export interface ConfigurationService {
  get: () => Promise<AcceptedConfigSnapshot>
  schema: () => unknown
  validate: (document: unknown) => Promise<DeclarativeConfig>
  plan: (input: {
    baseConfigHash: string
    targetConfig: unknown
  }) => Promise<ConfigurationPlan>
  apply: (input: {
    principalKey: string
    requestId: string
    idempotencyKey: string
    ifMatch: string | null
    request: ConfigurationApplyRequest
  }) => Promise<ConfigOperation>
  operation: (id: string) => Promise<ConfigOperation | null>
}

const OPERATION_COLUMNS = {
  id: configOperations.id,
  baseConfigHash: configOperations.baseConfigHash,
  targetConfigHash: configOperations.targetConfigHash,
  planHash: configOperations.planHash,
  state: configOperations.state,
  edgeConfigVersion: configOperations.edgeConfigVersion,
  rejectionReason: configOperations.rejectionReason,
  createdAt: configOperations.createdAt,
  writtenAt: configOperations.writtenAt,
  acceptedAt: configOperations.acceptedAt,
  failedAt: configOperations.failedAt,
}

type OperationRow = Pick<
  typeof configOperations.$inferSelect,
  keyof typeof OPERATION_COLUMNS
>

function serializeOperation(row: OperationRow): ConfigOperation {
  return {
    id: row.id,
    baseConfigHash: row.baseConfigHash,
    targetConfigHash: row.targetConfigHash,
    planHash: row.planHash,
    state: row.state,
    edgeConfigVersion: row.edgeConfigVersion,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    writtenAt: row.writtenAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  }
}

async function defaultWriteEdgeConfig(
  config: MonitoringConfig
): Promise<{ version: number | null }> {
  try {
    return { version: await writeMonitoringEdgeConfig(config) }
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
    throw new ConfigurationServiceError(
      "EDGE_CONFIG_WRITE_FAILED",
      "Could not write Edge Config",
      { cause: error }
    )
  }
}

function createDatabaseStore(): ConfigurationStore {
  const readAcceptedVia = async (
    executor: typeof db
  ): Promise<AcceptedConfigSnapshot | null> => {
    try {
      return await findAcceptedSnapshot(executor)
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
      throw new ConfigurationServiceError(
        "CONFIG_NOT_INITIALIZED",
        "Accepted configuration hash is invalid",
        { cause: error }
      )
    }
  }
  return {
    readAccepted: () => readAcceptedVia(db),
    transaction: async (work) =>
      await db.transaction(
        async (tx) =>
          await work({
            lockConfiguration: async () => {
              await acquireConfigurationLock(tx)
            },
            readAccepted: () => readAcceptedVia(tx as unknown as typeof db),
            findOperation: async (principalKey, idempotencyKey) => {
              const [row] = await tx
                .select(OPERATION_COLUMNS)
                .from(configOperations)
                .where(
                  sql`${configOperations.principalKey} = ${principalKey} and ${configOperations.idempotencyKey} = ${idempotencyKey}`
                )
                .limit(1)
              return row ? serializeOperation(row) : null
            },
            insertApproval: async (value) => {
              await tx.insert(configChangeApprovals).values(value)
            },
            insertOperation: async (value) =>
              serializeOperation(
                (
                  await tx
                    .insert(configOperations)
                    .values({ id: crypto.randomUUID(), ...value })
                    .returning(OPERATION_COLUMNS)
                )[0]!
              ),
          })
      ),
    readOperation: async (id) => {
      const [row] = await db
        .select(OPERATION_COLUMNS)
        .from(configOperations)
        .where(eq(configOperations.id, id))
        .limit(1)
      return row ? serializeOperation(row) : null
    },
  }
}

export function createConfigurationService(
  options: {
    writeEdgeConfig?: EdgeConfigWriter
    store?: ConfigurationStore
  } = {}
): ConfigurationService {
  const writeEdgeConfig = options.writeEdgeConfig ?? defaultWriteEdgeConfig
  const store = options.store ?? createDatabaseStore()
  const loadCurrent = async (): Promise<AcceptedConfigSnapshot> => {
    const current = await store.readAccepted()
    if (!current) {
      throw new ConfigurationServiceError(
        "CONFIG_NOT_INITIALIZED",
        "No accepted configuration is available"
      )
    }
    return current
  }

  return {
    get: loadCurrent,
    schema: async () =>
      (
        await import("@/lib/config/schema")
      ).declarativeConfigSchema.toJSONSchema(),
    validate: async (document) => validateDeclarativeConfig(document),
    plan: async ({ baseConfigHash, targetConfig }) => {
      const current = await loadCurrent()
      if (baseConfigHash !== current.hash) {
        throw new ConfigurationServiceError(
          "CONFIG_VERSION_CONFLICT",
          "The monitor configuration changed after it was loaded"
        )
      }
      return createConfigurationPlan(
        exportDeclarativeConfig(current.config),
        targetConfig,
        { baseConfigHash: current.hash }
      )
    },
    apply: async (input) =>
      await store.transaction(async (tx) => {
        await tx.lockConfiguration()
        const existing = await tx.findOperation(
          input.principalKey,
          input.idempotencyKey
        )
        if (existing) {
          return existing
        }
        const current = await tx.readAccepted()
        if (!current) {
          throw new ConfigurationServiceError(
            "CONFIG_NOT_INITIALIZED",
            "No accepted configuration is available"
          )
        }
        const currentConfig = current.config
        const currentHash = current.hash
        const plan = validateApplyPreconditions({
          ifMatch: input.ifMatch,
          request: input.request,
          currentConfig: exportDeclarativeConfig(currentConfig),
          currentConfigHash: currentHash,
        })
        const target = toMonitoringConfig(
          plan.targetConfig,
          currentConfig.configVersion + 1
        )
        const now = new Date()
        if (plan.tripwireApprovalRequired) {
          await tx.insertApproval({
            id: crypto.randomUUID(),
            targetConfigHash: plan.targetConfigHash,
            action: "destructive_config_change",
            createdByPrincipal: input.principalKey,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 10 * 60_000),
            consumedAt: null,
          })
        }
        let edge: { version: number | null }
        try {
          edge = await writeEdgeConfig(target)
        } catch (cause) {
          if (cause instanceof ConfigurationServiceError) {
            throw cause
          }
          // biome-ignore lint/style/useErrorCause: cause is threaded through the error options arg, biome only detects the native second-argument position
          throw new ConfigurationServiceError(
            "EDGE_CONFIG_WRITE_FAILED",
            "Could not write Edge Config",
            { cause }
          )
        }
        return await tx.insertOperation({
          principalKey: input.principalKey,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          baseConfigHash: currentHash,
          targetConfigHash: plan.targetConfigHash,
          planHash: plan.planHash,
          desiredConfig: target,
          diffJson: plan.diff,
          state: "written",
          edgeConfigVersion: edge.version,
          rejectionReason: null,
          createdAt: now,
          writtenAt: now,
          acceptedAt: null,
          failedAt: null,
        })
      }),
    operation: async (id) => await store.readOperation(id),
  }
}

export function configErrorCode(error: unknown): string | null {
  if (
    error instanceof ConfigApplyError ||
    error instanceof ConfigurationServiceError
  ) {
    return error.code
  }
  return null
}

export const configurationService = createConfigurationService()
