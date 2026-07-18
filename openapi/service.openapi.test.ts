import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

type Operation = {
  security?: unknown[];
  "x-required-scopes"?: string[];
};

const document = JSON.parse(
  readFileSync(join(process.cwd(), "openapi", "service.openapi.yaml"), "utf8"),
) as {
  openapi: string;
  paths: Record<string, Record<string, Operation | string>>;
  components: {
    pathItems: Record<string, Record<string, Operation>>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

const expectedOperations = [
  "GET /api/v1/version", "GET /api/v1/me", "GET /api/v1/monitors", "POST /api/v1/monitors",
  "GET /api/v1/monitors/{monitorId}", "PATCH /api/v1/monitors/{monitorId}", "DELETE /api/v1/monitors/{monitorId}",
  "POST /api/v1/monitors/{monitorId}/pause", "POST /api/v1/monitors/{monitorId}/resume", "POST /api/v1/monitors/{monitorId}/test",
  "GET /api/v1/incidents", "GET /api/v1/incidents/{incidentId}", "GET /api/v1/status", "GET /api/v1/config",
  "GET /api/v1/config/schema", "POST /api/v1/config/validate", "POST /api/v1/config/plan", "POST /api/v1/config/apply",
  "GET /api/v1/config/operations/{operationId}", "POST /api/v1/notifications/test", "POST /api/v1/tokens", "GET /api/v1/tokens",
  "DELETE /api/v1/tokens/{tokenId}", "POST /api/v1/cli-auth/device", "POST /api/v1/cli-auth/token", "POST /api/v1/cli-auth/revoke",
  "GET /api/v1/database-health", "POST /api/v1/database-health/refresh",
];

describe("committed OpenAPI v1 source", () => {
  it("documents the complete endpoint inventory", () => {
    const operations = Object.entries(document.paths).flatMap(([path, rawPathItem]) => {
      const reference = rawPathItem.$ref;
      const pathItem = typeof reference === "string"
        ? document.components.pathItems[reference.split("/").at(-1)!]
        : rawPathItem;
      return Object.keys(pathItem)
        .filter((method) => ["get", "post", "patch", "delete"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`);
    });
    expect(document.openapi).toBe("3.1.0");
    expect(operations.sort()).toEqual(expectedOperations.sort());
  });

  it("makes only compatibility and pre-auth device polling anonymous", () => {
    const operation = (path: string, method: string) =>
      document.paths[path][method] as Operation;
    expect(operation("/api/v1/version", "get").security).toEqual([]);
    expect(operation("/api/v1/cli-auth/device", "post").security).toEqual([]);
    expect(operation("/api/v1/cli-auth/token", "post").security).toEqual([]);
    expect(operation("/api/v1/me", "get").security).not.toEqual([]);
  });

  it("contains no broken local references", () => {
    const references: string[] = [];
    JSON.stringify(document, (key, value: unknown) => {
      if (key === "$ref" && typeof value === "string") references.push(value);
      return value;
    });
    for (const reference of references) {
      expect(reference).toMatch(/^#\//);
      const target = reference.slice(2).split("/").reduce<unknown>(
        (current, segment) => (current as Record<string, unknown>)[segment],
        document,
      );
      expect(target, reference).toBeDefined();
    }
  });

  it("documents rate limiting for every authenticated operation", () => {
    for (const rawPathItem of Object.values(document.paths)) {
      const reference = rawPathItem.$ref;
      const pathItem = typeof reference === "string"
        ? document.components.pathItems[reference.split("/").at(-1)!]
        : rawPathItem;
      for (const method of ["get", "post", "patch", "delete"]) {
        const operation = pathItem[method] as Operation & {
          responses?: Record<string, unknown>;
        };
        if (operation?.security?.length) {
          expect(operation.responses?.["429"], method).toBeDefined();
        }
      }
    }
  });

  it("matches the configuration domain constraints", () => {
    const schemas = document.components.schemas;
    const monitorFields = schemas.MonitorFields.properties as Record<string, Record<string, unknown>>;
    const plan = schemas.ConfigurationPlan.properties as Record<string, Record<string, unknown>>;
    const diff = plan.diff.properties as Record<string, Record<string, unknown>>;
    expect(monitorFields.intervalMinutes.enum).toEqual([1, 5, 10, 15]);
    expect(monitorFields.timeoutMs).toMatchObject({ minimum: 1000, maximum: 15000 });
    expect(monitorFields.failureThreshold).toMatchObject({ minimum: 1, maximum: 5 });
    expect(monitorFields.recipients.maxItems).toBe(20);
    expect(diff.settingsChanged.type).toBe("array");
    expect(schemas.MonitorConfig.unevaluatedProperties).toBe(false);
    expect(schemas.MonitoringSettings.additionalProperties).toBe(false);
  });

  it("matches the implemented route filesystem", () => {
    const root = join(process.cwd(), "app", "api", "v1");
    const implemented = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith("route.ts"))
      .flatMap((file) => {
        const source = readFileSync(join(root, file), "utf8");
        const route = relative(root, dirname(join(root, file))).split(sep)
          .map((segment) => segment.replace(/^\[(.+)]$/, "{$1}"))
          .join("/");
        return [...source.matchAll(/export async function (GET|POST|PATCH|DELETE)\b/g)]
          .map((match) => `${match[1]} /api/v1/${route}`.replace(/\/$/, ""));
      });
    expect(implemented.sort()).toEqual(expectedOperations.sort());
  });

  it("documents credential responses, bearer challenges, and envelope revocations", () => {
    const schemas = document.components.schemas as Record<string, Record<string, unknown>>;
    const createdToken = schemas.CreatedTokenEnvelope as {
      properties: { data: { allOf: Array<{ properties?: { token?: { writeOnly?: boolean } } }> } };
    };
    const deviceAuthorization = schemas.DeviceAuthorizationEnvelope as {
      properties: { data: { properties: { deviceCode: { writeOnly?: boolean } } } };
    };
    const deviceToken = schemas.DeviceTokenEnvelope as {
      properties: { data: { properties: { token: { writeOnly?: boolean } } } };
    };
    expect(createdToken.properties.data.allOf[1].properties?.token?.writeOnly).not.toBe(true);
    expect(deviceAuthorization.properties.data.properties.deviceCode.writeOnly).not.toBe(true);
    expect(deviceToken.properties.data.properties.token.writeOnly).not.toBe(true);
    const responses = (document as unknown as { components: { responses: Record<string, { headers?: unknown }> } }).components.responses;
    expect(responses.AuthenticationRequired.headers).toBeDefined();
    for (const [path, method] of [
      ["/api/v1/monitors/{monitorId}", "delete"],
      ["/api/v1/tokens/{tokenId}", "delete"],
      ["/api/v1/cli-auth/revoke", "post"],
    ] as const) {
      const operation = document.paths[path][method] as Operation & { responses: Record<string, unknown> };
      expect(operation.responses["200"]).toBeDefined();
      expect(operation.responses["204"]).toBeUndefined();
    }
  });

  it("requires semantic hash metadata for configuration export", () => {
    const configMeta = document.components.schemas.ConfigurationMeta as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(configMeta.required).toEqual(["requestId", "configHash"]);
    expect(configMeta.properties.configHash).toBeDefined();
    const response = (document.paths["/api/v1/config"].get as Operation & {
      responses: Record<string, { headers?: Record<string, unknown> }>;
    }).responses["200"];
    expect(response.headers?.ETag).toBeDefined();
  });

  it("documents database health caching and unavailable states", () => {
    const health = document.components.schemas.DatabaseHealth as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(health.required).toContain("freshness");
    expect(health.required).toContain("refresh");
    expect(health.properties.health.enum).toContain("UNKNOWN");
    expect(health.properties.freshness).toBeDefined();
    expect(health.properties.refresh).toBeDefined();
    const freshness = health.properties.freshness as unknown as {
      required: string[];
    };
    const refreshSchema = health.properties.refresh as unknown as {
      required: string[];
      properties: { status: { enum: string[] } };
    };
    expect(freshness.required).toContain("providerCapturedAt");
    expect(refreshSchema.required).toContain("status");
    expect(refreshSchema.properties.status.enum).toContain("STALE_FALLBACK");
    const refresh = document.paths["/api/v1/database-health/refresh"].post as Operation & {
      parameters: Array<{ $ref?: string }>;
      responses: Record<string, unknown>;
    };
    expect(refresh["x-required-scopes"]).toEqual(["config:write"]);
    expect(refresh.parameters.some((parameter) => parameter.$ref?.endsWith("/IdempotencyKey"))).toBe(true);
    expect(refresh.responses["503"]).toBeDefined();
  });

  it("defines the authoritative manual monitor-test outcome", () => {
    const envelope = document.components.schemas.MonitorTestEnvelope as {
      properties: { data: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } };
    };
    expect(envelope.properties.data.additionalProperties).toBe(false);
    expect(envelope.properties.data.required).toContain("successful");
    expect(envelope.properties.data.properties.successful).toEqual(expect.objectContaining({ type: "boolean" }));
    expect(envelope.properties.data.properties.success).toBeUndefined();
    expect(envelope.properties.data.properties.ok).toBeUndefined();
  });
});
