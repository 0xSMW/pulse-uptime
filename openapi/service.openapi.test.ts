import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

import { describe, expect, it } from "vitest"

type Operation = {
  security?: unknown[]
  "x-required-scopes"?: string[]
}

const document = JSON.parse(
  readFileSync(join(process.cwd(), "openapi", "service.openapi.yaml"), "utf8")
) as {
  openapi: string
  paths: Record<string, Record<string, Operation | string>>
  components: {
    pathItems: Record<string, Record<string, Operation>>
    schemas: Record<string, Record<string, unknown>>
  }
}

const expectedOperations = [
  "GET /api/v1/version",
  "GET /api/v1/me",
  "PATCH /api/v1/me",
  "POST /api/v1/me/email",
  "POST /api/v1/me/password",
  "DELETE /api/v1/me/sessions/{sessionId}",
  "POST /api/v1/me/sessions/revoke-others",
  "GET /api/v1/monitors",
  "POST /api/v1/monitors",
  "GET /api/v1/monitors/{monitorId}",
  "PATCH /api/v1/monitors/{monitorId}",
  "DELETE /api/v1/monitors/{monitorId}",
  "POST /api/v1/monitors/{monitorId}/pause",
  "POST /api/v1/monitors/{monitorId}/resume",
  "POST /api/v1/monitors/{monitorId}/test",
  "GET /api/v1/monitors/{monitorId}/live",
  "GET /api/v1/groups",
  "POST /api/v1/groups",
  "PATCH /api/v1/groups/{groupId}",
  "DELETE /api/v1/groups/{groupId}",
  "GET /api/v1/incidents",
  "GET /api/v1/incidents/{incidentId}",
  "GET /api/v1/status",
  "GET /api/v1/config",
  "GET /api/v1/config/schema",
  "POST /api/v1/config/validate",
  "POST /api/v1/config/plan",
  "POST /api/v1/config/apply",
  "GET /api/v1/config/operations/{operationId}",
  "POST /api/v1/notifications/test",
  "POST /api/v1/tokens",
  "GET /api/v1/tokens",
  "DELETE /api/v1/tokens/{tokenId}",
  "POST /api/v1/cli-auth/device",
  "POST /api/v1/cli-auth/token",
  "POST /api/v1/cli-auth/revoke",
  "GET /api/v1/database-health",
  "POST /api/v1/database-health/refresh",
  "GET /api/v1/status-page-config",
  "PUT /api/v1/status-page-config",
  "POST /api/v1/images",
  "GET /api/v1/images/{imageId}",
  "GET /api/v1/status-reports",
  "POST /api/v1/status-reports",
  "GET /api/v1/status-reports/{reportId}",
  "PATCH /api/v1/status-reports/{reportId}",
  "DELETE /api/v1/status-reports/{reportId}",
  "POST /api/v1/status-reports/{reportId}/publish",
  "POST /api/v1/status-reports/{reportId}/updates",
  "PATCH /api/v1/status-reports/{reportId}/updates/{updateId}",
  "DELETE /api/v1/status-reports/{reportId}/updates/{updateId}",
  "POST /api/v1/incidents/{incidentId}/promote",
  "GET /api/v1/dependency-catalog",
  "GET /api/v1/dependencies",
  "POST /api/v1/dependencies",
  "GET /api/v1/dependencies/{dependencyId}",
  "PATCH /api/v1/dependencies/{dependencyId}",
  "DELETE /api/v1/dependencies/{dependencyId}",
  "POST /api/v1/dependencies/{dependencyId}/refresh",
]

describe("committed OpenAPI v1 source", () => {
  it("documents the complete endpoint inventory", () => {
    const operations = Object.entries(document.paths).flatMap(
      ([path, rawPathItem]) => {
        const reference = rawPathItem.$ref
        const pathItem =
          typeof reference === "string"
            ? document.components.pathItems[reference.split("/").at(-1)!]
            : rawPathItem
        return Object.keys(pathItem)
          .filter((method) =>
            ["get", "post", "put", "patch", "delete"].includes(method)
          )
          .map((method) => `${method.toUpperCase()} ${path}`)
      }
    )
    expect(document.openapi).toBe("3.1.0")
    expect(operations.sort()).toEqual(expectedOperations.sort())
  })

  it("makes only compatibility and pre-auth device polling anonymous", () => {
    const operation = (path: string, method: string) =>
      document.paths[path][method] as Operation
    expect(operation("/api/v1/version", "get").security).toEqual([])
    expect(operation("/api/v1/cli-auth/device", "post").security).toEqual([])
    expect(operation("/api/v1/cli-auth/token", "post").security).toEqual([])
    expect(operation("/api/v1/me", "get").security).not.toEqual([])
  })

  it("contains no broken local references", () => {
    const references: string[] = []
    JSON.stringify(document, (key, value: unknown) => {
      if (key === "$ref" && typeof value === "string") {
        references.push(value)
      }
      return value
    })
    for (const reference of references) {
      expect(reference).toMatch(/^#\//)
      const target = reference
        .slice(2)
        .split("/")
        .reduce<unknown>(
          (current, segment) => (current as Record<string, unknown>)[segment],
          document
        )
      expect(target, reference).toBeDefined()
    }
  })

  it("documents rate limiting for every authenticated operation", () => {
    for (const rawPathItem of Object.values(document.paths)) {
      const reference = rawPathItem.$ref
      const pathItem =
        typeof reference === "string"
          ? document.components.pathItems[reference.split("/").at(-1)!]
          : rawPathItem
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const operation = pathItem[method] as Operation & {
          responses?: Record<string, unknown>
        }
        if (operation?.security?.length) {
          expect(operation.responses?.["429"], method).toBeDefined()
        }
      }
    }
  })

  it("matches the configuration domain constraints", () => {
    const schemas = document.components.schemas
    const monitorFields = schemas.MonitorFields.properties as Record<
      string,
      Record<string, unknown>
    >
    const plan = schemas.ConfigurationPlan.properties as Record<
      string,
      Record<string, unknown>
    >
    const diff = plan.diff.properties as Record<string, Record<string, unknown>>
    expect(monitorFields.intervalMinutes.enum).toEqual([1, 5, 10, 15])
    expect(monitorFields.timeoutMs).toMatchObject({
      minimum: 1000,
      maximum: 15_000,
    })
    expect(monitorFields.failureThreshold).toMatchObject({
      minimum: 1,
      maximum: 5,
    })
    expect(monitorFields.recipients.maxItems).toBe(20)
    expect(monitorFields.groupId).toMatchObject({ minLength: 3, maxLength: 64 })
    expect(diff.settingsChanged.type).toBe("array")
    expect(diff.groupCreates.type).toBe("array")
    expect(schemas.Configuration.properties).toMatchObject({
      version: { const: 2 },
      groups: { maxItems: 100 },
    })
    expect(schemas.Group).toMatchObject({
      unevaluatedProperties: false,
      required: ["id", "name", "monitorCount"],
    })
    const monitorCreate = schemas.MonitorCreate as {
      allOf: Array<{ not?: { required: string[] } }>
    }
    const monitorUpdate = schemas.MonitorUpdate as {
      allOf: Array<{ not?: { required: string[] } }>
    }
    const groupDelete = document.paths["/api/v1/groups/{groupId}"]
      .delete as Operation & {
      responses: Record<
        string,
        { content: Record<string, { schema: { $ref: string } }> }
      >
    }
    expect(monitorCreate.allOf[1].not?.required).toEqual(["group", "groupId"])
    expect(monitorUpdate.allOf[1].not?.required).toEqual(["group", "groupId"])
    expect(
      groupDelete.responses["200"].content["application/json"].schema.$ref
    ).toBe("#/components/schemas/GroupDeletionEnvelope")
    expect(schemas.MonitorConfig.unevaluatedProperties).toBe(false)
    expect(schemas.MonitoringSettings.additionalProperties).toBe(false)
  })

  it("matches the implemented route filesystem", () => {
    const root = join(process.cwd(), "app", "api", "v1")
    const implemented = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith("route.ts"))
      .flatMap((file) => {
        const source = readFileSync(join(root, file), "utf8")
        const route = relative(root, dirname(join(root, file)))
          .split(sep)
          .map((segment) => segment.replace(/^\[(.+)]$/, "{$1}"))
          .join("/")
        return [
          ...source.matchAll(
            /export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g
          ),
        ].map((match) => `${match[1]} /api/v1/${route}`.replace(/\/$/, ""))
      })
    expect(implemented.sort()).toEqual(expectedOperations.sort())
  })

  it("documents credential responses, bearer challenges, and envelope revocations", () => {
    const schemas = document.components.schemas as Record<
      string,
      Record<string, unknown>
    >
    const createdToken = schemas.CreatedTokenEnvelope as {
      properties: {
        data: {
          allOf: Array<{
            required?: string[]
            properties?: {
              token?: { writeOnly?: boolean; type?: string }
              expiryClamped?: { type?: string }
            }
          }>
        }
      }
    }
    const createdTokenData = createdToken.properties.data.allOf[1]
    expect(createdTokenData.required).toEqual(
      expect.arrayContaining(["token", "expiryClamped"])
    )
    expect(createdTokenData.properties?.expiryClamped?.type).toBe("boolean")
    expect(createdTokenData.properties?.token?.writeOnly).not.toBe(true)
    const deviceAuthorization = schemas.DeviceAuthorizationEnvelope as {
      properties: {
        data: { properties: { deviceCode: { writeOnly?: boolean } } }
      }
    }
    const deviceToken = schemas.DeviceTokenEnvelope as {
      properties: { data: { properties: { token: { writeOnly?: boolean } } } }
    }
    expect(
      deviceAuthorization.properties.data.properties.deviceCode.writeOnly
    ).not.toBe(true)
    expect(deviceToken.properties.data.properties.token.writeOnly).not.toBe(
      true
    )
    const responses = (
      document as unknown as {
        components: { responses: Record<string, { headers?: unknown }> }
      }
    ).components.responses
    expect(responses.AuthenticationRequired.headers).toBeDefined()
    for (const [path, method] of [
      ["/api/v1/monitors/{monitorId}", "delete"],
      ["/api/v1/tokens/{tokenId}", "delete"],
      ["/api/v1/cli-auth/revoke", "post"],
      ["/api/v1/status-reports/{reportId}", "delete"],
      ["/api/v1/status-reports/{reportId}/updates/{updateId}", "delete"],
    ] as const) {
      const operation = document.paths[path][method] as Operation & {
        responses: Record<string, unknown>
      }
      expect(operation.responses["200"]).toBeDefined()
      expect(operation.responses["204"]).toBeUndefined()
    }
  })

  it("requires semantic hash metadata for configuration export", () => {
    const configMeta = document.components.schemas.ConfigurationMeta as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(configMeta.required).toEqual(["requestId", "configHash"])
    expect(configMeta.properties.configHash).toBeDefined()
    const response = (
      document.paths["/api/v1/config"].get as Operation & {
        responses: Record<string, { headers?: Record<string, unknown> }>
      }
    ).responses["200"]
    expect(response.headers?.ETag).toBeDefined()
  })

  it("documents the status page configuration concurrency contract", () => {
    const get = document.paths["/api/v1/status-page-config"]
      .get as Operation & {
      responses: Record<string, { headers?: Record<string, unknown> }>
    }
    const put = document.paths["/api/v1/status-page-config"]
      .put as Operation & {
      parameters: Array<{ name?: string; required?: boolean; $ref?: string }>
      responses: Record<string, unknown>
    }
    expect(get["x-required-scopes"]).toEqual(["config:read"])
    expect(get.responses["200"].headers?.ETag).toBeDefined()
    expect(put["x-required-scopes"]).toEqual(["config:write"])
    expect(
      put.parameters.some(
        (parameter) => parameter.name === "If-Match" && parameter.required
      )
    ).toBe(true)
    // The route requires Idempotency-Key just like every other mutation
    // (finding: the spec omitted it for this PUT even though the handler
    // 400s IDEMPOTENCY_KEY_REQUIRED without it) — same shared parameter ref
    // asserted for every status-reports mutation and the database-health
    // refresh below.
    expect(
      put.parameters.some((parameter) =>
        parameter.$ref?.endsWith("/IdempotencyKey")
      )
    ).toBe(true)
    expect(put.responses["412"]).toBeDefined()
    expect(put.responses["428"]).toBeDefined()
    const config = document.components.schemas.StatusPageConfig as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(config.properties.navLinks).toMatchObject({ maxItems: 8 })
    expect(config.properties.historyDays.enum).toEqual([30, 60, 90])
    expect(config.properties.updatedAt).toMatchObject({ readOnly: true })
    const upload = document.paths["/api/v1/images"].post as Operation & {
      requestBody: {
        content: Record<string, { schema: { required: string[] } }>
      }
    }
    expect(upload["x-required-scopes"]).toEqual(["config:write"])
    expect(
      upload.requestBody.content["multipart/form-data"].schema.required
    ).toEqual(["file", "kind"])
  })

  it("documents the status reports contract", () => {
    const schemas = document.components.schemas
    const scope = schemas.Scope as { enum: string[] }
    expect(scope.enum).toContain("reports:read")
    expect(scope.enum).toContain("reports:write")

    const operation = (path: string, method: string) =>
      document.paths[path][method] as Operation & {
        parameters?: Array<{ $ref?: string }>
        responses: Record<string, unknown>
      }
    expect(
      operation("/api/v1/status-reports", "get")["x-required-scopes"]
    ).toEqual(["reports:read"])
    expect(
      operation("/api/v1/status-reports", "post")["x-required-scopes"]
    ).toEqual(["reports:write"])
    expect(
      operation("/api/v1/status-reports/{reportId}", "get")["x-required-scopes"]
    ).toEqual(["reports:read"])
    expect(
      operation("/api/v1/incidents/{incidentId}/promote", "post")[
        "x-required-scopes"
      ]
    ).toEqual(["reports:write"])

    // Every mutation is idempotent and both conflict cases (ALREADY_PUBLISHED,
    // LAST_UPDATE) are visible as 409s.
    for (const [path, method] of [
      ["/api/v1/status-reports", "post"],
      ["/api/v1/status-reports/{reportId}", "patch"],
      ["/api/v1/status-reports/{reportId}", "delete"],
      ["/api/v1/status-reports/{reportId}/publish", "post"],
      ["/api/v1/status-reports/{reportId}/updates", "post"],
      ["/api/v1/status-reports/{reportId}/updates/{updateId}", "patch"],
      ["/api/v1/status-reports/{reportId}/updates/{updateId}", "delete"],
      ["/api/v1/incidents/{incidentId}/promote", "post"],
    ] as const) {
      const mutation = operation(path, method)
      expect(mutation["x-required-scopes"], `${method} ${path}`).toEqual([
        "reports:write",
      ])
      expect(
        mutation.parameters?.some((parameter) =>
          parameter.$ref?.endsWith("/IdempotencyKey")
        ),
        `${method} ${path}`
      ).toBe(true)
      expect(mutation.responses["409"], `${method} ${path}`).toBeDefined()
    }

    const report = schemas.StatusReport as {
      required: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(report.required).toEqual(
      expect.arrayContaining([
        "publishedAt",
        "resolvedAt",
        "currentStatus",
        "updates",
        "affected",
      ])
    )
    expect(report.properties.publishedAt.type).toEqual(["string", "null"])
    expect(report.properties.title).toMatchObject({
      minLength: 1,
      maxLength: 160,
    })
    const updateSchema = schemas.StatusReportUpdate as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(updateSchema.properties.markdown).toMatchObject({
      minLength: 1,
      maxLength: 10_240,
    })
    const create = schemas.StatusReportCreateRequest as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(create.required).toEqual(["type", "title", "update"])
    expect(create.properties.draft).toMatchObject({ type: "boolean" })
    const status = schemas.StatusReportUpdateStatus as { enum: string[] }
    expect(status.enum).toEqual([
      "investigating",
      "identified",
      "monitoring",
      "resolved",
      "scheduled",
      "in_progress",
      "completed",
    ])
    const list = schemas.StatusReportListEnvelope as {
      properties: { kind: { const: string } }
    }
    expect(list.properties.kind.const).toBe("StatusReportList")
  })

  it("documents database health caching and unavailable states", () => {
    const health = document.components.schemas.DatabaseHealth as {
      required: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(health.required).toContain("freshness")
    expect(health.required).toContain("refresh")
    expect(health.properties.health.enum).toContain("UNKNOWN")
    expect(health.properties.freshness).toBeDefined()
    expect(health.properties.refresh).toBeDefined()
    const freshness = health.properties.freshness as unknown as {
      required: string[]
    }
    const refreshSchema = health.properties.refresh as unknown as {
      required: string[]
      properties: { status: { enum: string[] } }
    }
    expect(freshness.required).toContain("providerCapturedAt")
    expect(refreshSchema.required).toContain("status")
    expect(refreshSchema.properties.status.enum).toContain("STALE_FALLBACK")
    const refresh = document.paths["/api/v1/database-health/refresh"]
      .post as Operation & {
      parameters: Array<{ $ref?: string }>
      responses: Record<string, unknown>
    }
    expect(refresh["x-required-scopes"]).toEqual(["config:write"])
    expect(
      refresh.parameters.some((parameter) =>
        parameter.$ref?.endsWith("/IdempotencyKey")
      )
    ).toBe(true)
    expect(refresh.responses["503"]).toBeDefined()
  })

  it("defines the authoritative manual monitor-test outcome", () => {
    const envelope = document.components.schemas.MonitorTestEnvelope as {
      properties: {
        data: {
          additionalProperties: boolean
          required: string[]
          properties: Record<string, unknown>
        }
      }
    }
    expect(envelope.properties.data.additionalProperties).toBe(false)
    expect(envelope.properties.data.required).toContain("successful")
    expect(envelope.properties.data.properties.successful).toEqual(
      expect.objectContaining({ type: "boolean" })
    )
    expect(envelope.properties.data.properties.success).toBeUndefined()
    expect(envelope.properties.data.properties.ok).toBeUndefined()
  })
})
