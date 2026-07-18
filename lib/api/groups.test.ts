import { describe, expect, it } from "vitest";
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DEFAULT_MONITOR_SETTINGS, createMonitorWithDefaults, type MonitoringConfig } from "@/lib/config";
import { addGroup, GroupApiError, removeGroup, renameGroup } from "./groups";

const base = (): MonitoringConfig => ({ schemaVersion: 2, configVersion: 1, settings: { ...DEFAULT_MONITOR_SETTINGS }, groups: [], monitors: [] });

describe("group configuration mutations", () => {
  it("creates and renames an empty group without changing monitor references", () => {
    const created = addGroup(base(), { id: "production", name: "Production" });
    const renamed = renameGroup(created, "production", { name: "Core" });
    expect(renamed.groups).toEqual([{ id: "production", name: "Core" }]);
    expect(renamed.configVersion).toBe(3);
  });

  it("enforces case-insensitive name uniqueness", () => {
    const created = addGroup(base(), { id: "production", name: "Production" });
    expect(() => addGroup(created, { id: "other", name: "production" })).toThrow(GroupApiError);
  });

  it("deletes empty groups and blocks referenced groups", () => {
    const created = addGroup(base(), { id: "production", name: "Production" });
    expect(removeGroup(created, "production").groups).toEqual([]);
    const referenced = { ...created, monitors: [{ ...createMonitorWithDefaults({ id: "website", name: "Website", url: "https://example.com" }), groupId: "production" }] };
    expect(() => removeGroup(referenced, "production")).toThrowError(expect.objectContaining({ code: "GROUP_NOT_EMPTY", details: { monitorCount: 1 } }));
  });
});
