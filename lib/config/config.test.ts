import { describe, expect, it } from "vitest";
import {
  ConfigApplyError,
  ConfigSizeError,
  DEFAULT_MONITOR_VALUES,
  calculateConfigurationDiff,
  canonicalSerialize,
  createConfigurationPlan,
  createMonitorWithDefaults,
  evaluateConfigurationAcceptance,
  evaluateDestructiveChange,
  exportDeclarativeConfig,
  hashCanonical,
  hashDeclarativeConfig,
  hashMonitoringConfig,
  isValidDestructiveApproval,
  resolveMonitorRecipients,
  toMonitoringConfig,
  validateApplyPreconditions,
  validateDeclarativeConfig,
  validateMonitoringConfig,
  type DeclarativeConfig,
  type DestructiveApproval,
  type MonitorConfig,
  type MonitoringConfig,
} from "./index";

const settings = {
  concurrency: 25,
  defaultTimeoutMs: 8_000,
  defaultFailureThreshold: 2,
  defaultRecoveryThreshold: 2,
  defaultRecipients: ["ops@example.com"],
  userAgent: "Pulse/1.0",
};

function monitor(id: string, overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    id,
    name: id.toUpperCase(),
    url: `https://${id}.example.com`,
    enabled: true,
    group: null,
    method: "GET",
    intervalMinutes: 1,
    timeoutMs: 8_000,
    expectedStatus: { minimum: 200, maximum: 399 },
    failureThreshold: 2,
    recoveryThreshold: 2,
    recipients: [],
    ...overrides,
  };
}

function document(monitors: MonitorConfig[] = [], overrides: Partial<DeclarativeConfig["settings"]> = {}): DeclarativeConfig {
  return { version: 1, settings: { ...settings, ...overrides }, monitors };
}

function runtime(monitors: MonitorConfig[] = [], configVersion = 1): MonitoringConfig {
  return { schemaVersion: 1, configVersion, settings: { ...settings }, monitors };
}

describe("configuration schemas and normalization", () => {
  it("accepts valid complete documents and applies documented monitor defaults", () => {
    const created = createMonitorWithDefaults({ id: "web", name: "Website", url: "https://example.com" });
    expect(created).toMatchObject(DEFAULT_MONITOR_VALUES);
    expect(created).toMatchObject({
      method: "GET", intervalMinutes: 1, timeoutMs: 8_000,
      expectedStatus: { minimum: 200, maximum: 399 }, failureThreshold: 2,
      recoveryThreshold: 2, group: null, enabled: true,
    });
    expect(validateDeclarativeConfig(document([created])).monitors[0].url).toBe("https://example.com/");
    expect(resolveMonitorRecipients(created, settings)).toEqual(["ops@example.com"]);
    expect(resolveMonitorRecipients({ recipients: ["owner@example.com"] }, settings)).toEqual(["owner@example.com"]);
  });

  it.each([
    ["duplicate IDs", document([monitor("api"), monitor("api")])],
    ["uppercase slug", document([monitor("API")])],
    ["private IPv4", document([monitor("api", { url: "http://127.0.0.1" })])],
    ["localhost", document([monitor("api", { url: "http://localhost" })])],
    ["non-http URL", document([monitor("api", { url: "ftp://example.com" })])],
    ["reversed status range", document([monitor("api", { expectedStatus: { minimum: 500, maximum: 200 } })])],
    ["too many active monitors", document(Array.from({ length: 101 }, (_, index) => monitor(`mon-${index}`)))],
  ])("rejects invalid schema: %s", (_label, input) => {
    expect(() => validateDeclarativeConfig(input)).toThrow();
  });

  it("normalizes monitor order, recipients, strings, URLs, and object keys deterministically", () => {
    const input = document([
      monitor("zzz", { recipients: ["B@example.com", "a@example.com", "b@example.com"] }),
      monitor("aaa", { name: "  Alpha  ", group: "  Ops  " }),
    ], { defaultRecipients: ["Z@example.com", "a@example.com"] });
    const normalized = validateDeclarativeConfig(input);
    expect(normalized.monitors.map(({ id }) => id)).toEqual(["aaa", "zzz"]);
    expect(normalized.monitors[0]).toMatchObject({ name: "Alpha", group: "Ops" });
    expect(normalized.monitors[1].recipients).toEqual(["a@example.com", "b@example.com"]);
    expect(normalized.settings.defaultRecipients).toEqual(["a@example.com", "z@example.com"]);
    expect(canonicalSerialize({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(hashCanonical(input)).toBe(hashCanonical(structuredClone(input)));
  });

  it("enforces the 55 KB canonical serialized limit", () => {
    const huge = document([monitor("api", { recipients: [`a@${"x".repeat(56_000)}.com`] })]);
    expect(() => validateDeclarativeConfig(huge)).toThrow(ConfigSizeError);
  });
});

describe("destructive-change tripwire", () => {
  it("trips when a non-empty active config becomes empty", () => {
    const result = evaluateDestructiveChange(document([monitor("api")]), document([]));
    expect(result.required).toBe(true);
    expect(result.reasons.map(({ type }) => type)).toContain("all-active-monitors-removed");
  });

  it("uses strict count and percentage thresholds", () => {
    const thirty = Array.from({ length: 30 }, (_, index) => monitor(`mon-${index}`));
    const countResult = evaluateDestructiveChange(document(thirty), document(thirty.slice(6)));
    expect(countResult.reasons.map(({ type }) => type)).toContain("removed-monitor-count");
    expect(countResult.reasons.map(({ type }) => type)).not.toContain("removed-monitor-percentage");

    const twenty = Array.from({ length: 20 }, (_, index) => monitor(`web-${index}`));
    const percentageResult = evaluateDestructiveChange(document(twenty), document(twenty.slice(5)));
    expect(percentageResult.reasons.map(({ type }) => type)).toContain("removed-monitor-percentage");
    expect(percentageResult.reasons.map(({ type }) => type)).not.toContain("removed-monitor-count");
  });

  it("trips on removal of every previously active member of a 2+ monitor group", () => {
    const grouped = [monitor("grp-a", { group: "Production" }), monitor("grp-b", { group: "Production" })];
    const unrelated = Array.from({ length: 8 }, (_, index) => monitor(`web-${index}`));
    const replacement = monitor("grp-new", { group: "Production" });
    const result = evaluateDestructiveChange(document([...grouped, ...unrelated]), document([...unrelated, replacement]));
    expect(result.reasons).toContainEqual({ type: "active-group-removed", group: "Production", previousActiveCount: 2 });
    expect(result.reasons.map(({ type }) => type)).not.toContain("removed-monitor-percentage");
  });

  it("trips when every existing member is moved out of a 2+ monitor group", () => {
    const grouped = [monitor("grp-a", { group: "Production" }), monitor("grp-b", { group: "Production" })];
    const unrelated = Array.from({ length: 8 }, (_, index) => monitor(`web-${index}`));
    const moved = grouped.map((entry) => ({ ...entry, group: "Other" }));
    const result = evaluateDestructiveChange(document([...grouped, ...unrelated]), document([...moved, ...unrelated]));
    expect(result.reasons).toContainEqual({ type: "active-group-removed", group: "Production", previousActiveCount: 2 });
  });

  it("does not apply the group-wide rule to a one-monitor group", () => {
    const sole = monitor("solo", { group: "Small" });
    const unrelated = Array.from({ length: 9 }, (_, index) => monitor(`web-${index}`));
    const result = evaluateDestructiveChange(document([sole, ...unrelated]), document(unrelated));
    expect(result.required).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

describe("planning and export", () => {
  it("round-trips exported accepted configuration with an empty semantic plan", () => {
    const accepted = validateMonitoringConfig(runtime([monitor("web"), monitor("api")]));
    const exported = exportDeclarativeConfig(accepted);
    const plan = createConfigurationPlan(exported, exported);
    expect(plan.diff).toMatchObject({
      settingsChanged: [], creates: [], updates: [], pauses: [], resumes: [], archives: [],
    });
    expect(plan.diff.unchanged.map(({ id }) => id)).toEqual(["api", "web"]);
    expect(toMonitoringConfig(exported, 9)).toMatchObject({ schemaVersion: 1, configVersion: 9 });
    expect(hashMonitoringConfig(accepted)).toBe(hashDeclarativeConfig(exported));
    expect(hashMonitoringConfig({ ...accepted, configVersion: 99 })).toBe(hashMonitoringConfig(accepted));
  });

  it("produces stable diffs and plan hashes regardless of source monitor order", () => {
    const current = document([monitor("bbb"), monitor("aaa")]);
    const targetA = document([monitor("bbb", { timeoutMs: 9_000 }), monitor("aaa")], { concurrency: 30 });
    const targetB = document([...targetA.monitors].reverse(), { concurrency: 30 });
    const first = createConfigurationPlan(current, targetA);
    const second = createConfigurationPlan(current, targetB);
    expect(first.planHash).toBe(second.planHash);
    expect(first.diff.settingsChanged.map(({ path }) => path)).toEqual(["settings.concurrency"]);
    expect(first.diff.updates.map(({ id }) => id)).toEqual(["bbb"]);
  });

  it("classifies pauses, resumes, updates, omitted archives, and creates", () => {
    const current = document([
      monitor("pause"), monitor("resume", { enabled: false }),
      monitor("gone"), monitor("changed", { enabled: false }),
    ]);
    const target = document([
      monitor("pause", { enabled: false }), monitor("resume"),
      monitor("changed", { enabled: false, timeoutMs: 10_000 }), monitor("new-one"),
    ]);
    const diff = calculateConfigurationDiff(validateDeclarativeConfig(current), validateDeclarativeConfig(target));
    expect(diff.pauses.map(({ id }) => id)).toEqual(["pause"]);
    expect(diff.resumes.map(({ id }) => id)).toEqual(["resume"]);
    expect(diff.updates.map(({ id }) => id)).toEqual(["changed"]);
    expect(diff.archives.map(({ id }) => id)).toEqual(["gone"]);
    expect(diff.creates.map(({ id }) => id)).toEqual(["new-one"]);
  });

  it("classifies an archived ID as a restore rather than a create", () => {
    const archived = monitor("old", { enabled: false });
    const plan = createConfigurationPlan(document([]), document([monitor("old")]), { archivedMonitors: [archived] });
    expect(plan.diff.creates).toEqual([]);
    expect(plan.diff.updates[0]).toMatchObject({ id: "old", restore: true });
    expect(plan.diff.resumes.map(({ id }) => id)).toEqual(["old"]);
  });
});

describe("acceptance, approvals, and fallback", () => {
  const now = new Date("2026-07-18T00:00:00Z");

  it("accepts valid candidates and falls back to the last snapshot for invalid candidates", () => {
    const acceptedConfig = validateMonitoringConfig(runtime([monitor("api")]));
    const snapshot = { config: acceptedConfig, hash: hashMonitoringConfig(acceptedConfig) };
    expect(evaluateConfigurationAcceptance(runtime([monitor("api"), monitor("web")], 2), snapshot).status).toBe("accepted");
    const rejected = evaluateConfigurationAcceptance({ nope: true }, snapshot);
    expect(rejected).toMatchObject({ status: "rejected", reason: "INVALID_CONFIGURATION", fallbackUsed: true, hash: snapshot.hash });
    expect(evaluateConfigurationAcceptance({ nope: true }, null)).toMatchObject({ status: "unavailable", config: null });
  });

  it("requires an exact, live, unconsumed approval for destructive acceptance", () => {
    const current = validateMonitoringConfig(runtime([monitor("api")], 1));
    const desired = validateMonitoringConfig(runtime([], 2));
    const snapshot = { config: current, hash: hashMonitoringConfig(current) };
    const targetConfigHash = hashMonitoringConfig(desired);
    const approval: DestructiveApproval = {
      action: "bulk_archive", targetConfigHash,
      expiresAt: new Date(now.getTime() + 60_000), consumedAt: null,
    };
    expect(evaluateConfigurationAcceptance(desired, snapshot, { approval, now })).toMatchObject({ status: "accepted", approvalConsumed: true });
    expect(isValidDestructiveApproval({ ...approval, targetConfigHash: "sha256:wrong" }, targetConfigHash, now)).toBe(false);
    expect(isValidDestructiveApproval({ ...approval, expiresAt: now }, targetConfigHash, now)).toBe(false);
    expect(isValidDestructiveApproval({ ...approval, consumedAt: now }, targetConfigHash, now)).toBe(false);
    expect(evaluateConfigurationAcceptance(desired, snapshot, { now })).toMatchObject({
      status: "rejected", reason: "DESTRUCTIVE_APPROVAL_REQUIRED", fallbackUsed: true,
    });
  });
});

describe("pure apply preconditions", () => {
  const current = validateDeclarativeConfig(document([monitor("api"), monitor("web")]));
  const target = validateDeclarativeConfig(document([monitor("api", { timeoutMs: 9_000 })]));
  const baseConfigHash = hashDeclarativeConfig(current);
  const plan = createConfigurationPlan(current, target, { baseConfigHash });

  const request = {
    baseConfigHash,
    targetConfigHash: plan.targetConfigHash,
    planHash: plan.planHash,
    targetConfig: target,
    allowDelete: true,
  };

  it("recomputes and returns the authoritative plan", () => {
    const result = validateApplyPreconditions({ ifMatch: `"${baseConfigHash}"`, request, currentConfig: current, currentConfigHash: baseConfigHash });
    expect(result.diff.archives.map(({ id }) => id)).toEqual(["web"]);
  });

  it.each([
    ["PRECONDITION_MISMATCH", { ifMatch: undefined }],
    ["PRECONDITION_MISMATCH", { ifMatch: '"sha256:wrong"' }],
    ["CONFIG_VERSION_CONFLICT", { currentConfigHash: "sha256:newer" }],
    ["TARGET_CONFIG_HASH_MISMATCH", { request: { ...request, targetConfigHash: "sha256:forged" } }],
    ["PLAN_HASH_MISMATCH", { request: { ...request, planHash: "sha256:forged" } }],
    ["DELETE_NOT_ALLOWED", { request: { ...request, allowDelete: false } }],
  ])("rejects %s", (code, override) => {
    try {
      validateApplyPreconditions({
        ifMatch: baseConfigHash,
        request,
        currentConfig: current,
        currentConfigHash: baseConfigHash,
        ...override,
      });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigApplyError);
      expect((error as ConfigApplyError).code).toBe(code);
    }
  });

  it("ignores a client-supplied forged diff", () => {
    const forged = { ...request, diff: { archives: [] } };
    const result = validateApplyPreconditions({
      ifMatch: baseConfigHash,
      request: forged,
      currentConfig: current,
      currentConfigHash: baseConfigHash,
    });
    expect(result.diff.archives.map(({ id }) => id)).toEqual(["web"]);
  });
});
