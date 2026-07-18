import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DEFAULT_MONITOR_SETTINGS, hashMonitoringConfig, type ConfigurationApplyRequest, type MonitoringConfig } from "@/lib/config";

import { createConfigurationService, type ConfigurationStore } from "./config-service";

const current: MonitoringConfig = {
  schemaVersion: 2,
  configVersion: 4,
  settings: { ...DEFAULT_MONITOR_SETTINGS },
  groups: [],
  monitors: [],
};
const currentHash = hashMonitoringConfig(current);

function makeStore(): ConfigurationStore {
  return {
    readAccepted: vi.fn(async () => ({ config: current, hash: currentHash })),
    transaction: async (work) => await work({
      lockConfiguration: vi.fn(async () => undefined),
      readAccepted: vi.fn(async () => ({ config: current, hash: currentHash })),
      findOperation: vi.fn(async () => null),
      insertApproval: vi.fn(async () => undefined),
      insertOperation: vi.fn(async (value) => ({
        id: "operation-1", baseConfigHash: value.baseConfigHash, targetConfigHash: value.targetConfigHash,
        planHash: value.planHash, state: "written" as const, edgeConfigVersion: value.edgeConfigVersion ?? null,
        rejectionReason: null, createdAt: (value.createdAt as Date).toISOString(),
        writtenAt: (value.writtenAt as Date).toISOString(), acceptedAt: null, failedAt: null,
      })),
    }),
    readOperation: vi.fn(async () => null),
  };
}

describe("configuration service seams", () => {
  it("uses the injected store and writes the complete normalized target through the injected Edge writer", async () => {
    const store = makeStore();
    const writeEdgeConfig = vi.fn(async () => ({ version: 42 }));
    const service = createConfigurationService({ store, writeEdgeConfig });
    const targetConfig = { version: 2 as const, settings: { ...DEFAULT_MONITOR_SETTINGS }, groups: [], monitors: [] };
    const plan = await service.plan({ baseConfigHash: currentHash, targetConfig });
    const request: ConfigurationApplyRequest = { ...plan, targetConfig, allowDelete: false };

    const operation = await service.apply({
      principalKey: "human:admin", requestId: "req-1", idempotencyKey: "key-1", ifMatch: `\"${currentHash}\"`, request,
    });

    expect(writeEdgeConfig).toHaveBeenCalledWith({ ...current, configVersion: 5 });
    expect(operation).toMatchObject({ id: "operation-1", state: "written", edgeConfigVersion: 42, targetConfigHash: plan.targetConfigHash });
  });
});
