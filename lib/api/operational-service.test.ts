import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createOperationalService, OperationalInputError, parseIncidentCursor } from "./operational-service";
import { encodeCursor } from "./pagination";

describe("operational service seams", () => {
  it("rejects malformed incident cursors before querying storage", () => {
    expect(() => parseIncidentCursor("not-a-cursor")).toThrow(OperationalInputError);
    expect(() => parseIncidentCursor(encodeCursor({ sort: "not-a-date", id: "incident-1" }))).toThrow("Cursor is invalid");
  });

  it("injects private-status retrieval without provider access", async () => {
    const service = createOperationalService({
      database: {} as never,
      getStatus: async () => ({ overallState: "operational", source: "fixture" }),
    });
    await expect(service.getStatus()).resolves.toEqual({ overallState: "operational", source: "fixture" });
  });
});
