import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateDeployProof,
  parsePromotionBoundary,
  serializeDeployProof,
  type DeployProofRunSnapshot,
  type DeployProofStore,
} from "./deploy-proof";

const RELEASE = "dpl_current";
const OTHER = "dpl_other";
const BOUNDARY = new Date("2026-07-20T12:00:00.000Z");

function run(partial: Partial<DeployProofRunSnapshot> & Pick<DeployProofRunSnapshot, "runId" | "status">): DeployProofRunSnapshot {
  return {
    scheduledMinute: new Date("2026-07-20T12:01:00.000Z"),
    startedAt: new Date("2026-07-20T12:01:01.000Z"),
    completedAt: partial.status === "running" ? null : new Date("2026-07-20T12:01:10.000Z"),
    releaseId: RELEASE,
    ...partial,
  };
}

function store(opts: {
  qualifying?: DeployProofRunSnapshot | null;
  latest?: DeployProofRunSnapshot | null;
}): DeployProofStore {
  return {
    findQualifyingCompleted: vi.fn(async () => opts.qualifying ?? null),
    findLatestForRelease: vi.fn(async () => opts.latest ?? null),
  };
}

describe("evaluateDeployProof", () => {
  it("returns ready when a completed current-release run finishes after promotion", async () => {
    const qualifying = run({
      runId: "run-ready",
      status: "completed",
      completedAt: new Date("2026-07-20T12:01:10.000Z"),
    });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: store({ qualifying }),
    });
    expect(result).toEqual({
      status: "ready",
      releaseId: RELEASE,
      runId: "run-ready",
      scheduledMinute: qualifying.scheduledMinute,
      startedAt: qualifying.startedAt,
      completedAt: qualifying.completedAt,
    });
  });

  it("returns waiting when only another release has a completed run", async () => {
    // Store filters by releaseId, so other-release rows never appear as qualifying.
    const s = store({ qualifying: null, latest: null });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: s,
    });
    expect(result.status).toBe("waiting");
    expect(s.findQualifyingCompleted).toHaveBeenCalledWith({
      releaseId: RELEASE,
      after: BOUNDARY,
    });
  });

  it("returns waiting when only a running row exists for the release", async () => {
    const latest = run({ runId: "run-running", status: "running", completedAt: null });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: store({ qualifying: null, latest }),
    });
    expect(result).toEqual({
      status: "waiting",
      releaseId: RELEASE,
      latest,
    });
  });

  it("returns waiting with diagnostics when only a failed row exists", async () => {
    const latest = run({
      runId: "run-failed",
      status: "failed",
      completedAt: new Date("2026-07-20T12:01:10.000Z"),
    });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: store({ qualifying: null, latest }),
    });
    expect(result).toEqual({
      status: "waiting",
      releaseId: RELEASE,
      latest,
    });
    expect(result.status === "waiting" && result.latest?.status).toBe("failed");
  });

  it("returns waiting when the only completed run finished before promotion", async () => {
    // completed_at < after is excluded by findQualifyingCompleted.
    const latest = run({
      runId: "run-old",
      status: "completed",
      completedAt: new Date("2026-07-20T11:59:00.000Z"),
    });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: store({ qualifying: null, latest }),
    });
    expect(result.status).toBe("waiting");
  });

  it("only the expected deployment qualifies when the same commit has another deployment id", async () => {
    const s = store({
      qualifying: run({
        runId: "run-expected",
        status: "completed",
        releaseId: RELEASE,
        completedAt: new Date("2026-07-20T12:02:00.000Z"),
      }),
    });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: s,
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.releaseId).toBe(RELEASE);
      expect(result.releaseId).not.toBe(OTHER);
    }
    expect(s.findQualifyingCompleted).toHaveBeenCalledWith({
      releaseId: RELEASE,
      after: BOUNDARY,
    });
  });

  it("does not treat null release_id historical rows as qualifying", async () => {
    // Null release_id cannot equal the current release filter.
    const s = store({ qualifying: null, latest: null });
    const result = await evaluateDeployProof({
      releaseId: RELEASE,
      after: BOUNDARY,
      store: s,
    });
    expect(result).toEqual({
      status: "waiting",
      releaseId: RELEASE,
      latest: null,
    });
    expect(s.findQualifyingCompleted).toHaveBeenCalledWith({
      releaseId: RELEASE,
      after: BOUNDARY,
    });
  });
});

describe("parsePromotionBoundary", () => {
  it("accepts ISO timestamps and rejects bad input", () => {
    expect(parsePromotionBoundary("2026-07-20T12:00:00.000Z")?.toISOString())
      .toBe("2026-07-20T12:00:00.000Z");
    expect(parsePromotionBoundary(null)).toBeNull();
    expect(parsePromotionBoundary("")).toBeNull();
    expect(parsePromotionBoundary("not-a-date")).toBeNull();
  });
});

describe("serializeDeployProof", () => {
  it("serializes ready and waiting bodies with ISO timestamps", () => {
    const ready = serializeDeployProof({
      status: "ready",
      releaseId: RELEASE,
      runId: "run-1",
      scheduledMinute: new Date("2026-07-20T12:01:00.000Z"),
      startedAt: new Date("2026-07-20T12:01:01.000Z"),
      completedAt: new Date("2026-07-20T12:01:10.000Z"),
    });
    expect(ready).toEqual({
      status: "ready",
      releaseId: RELEASE,
      runId: "run-1",
      scheduledMinute: "2026-07-20T12:01:00.000Z",
      startedAt: "2026-07-20T12:01:01.000Z",
      completedAt: "2026-07-20T12:01:10.000Z",
    });

    const waiting = serializeDeployProof({
      status: "waiting",
      releaseId: RELEASE,
      latest: run({ runId: "run-f", status: "failed" }),
    });
    expect(waiting.status).toBe("waiting");
    expect((waiting.latest as { status: string }).status).toBe("failed");
  });
});
