import { describe, expect, it, vi } from "vitest";

import { createHttpChecker, runManualCheck, type CheckerDependencies } from "./checker";
import type { CheckerResponse, ManagedDispatcher, RequestExecutor } from "./types";

const target = {
  url: "https://example.com/health",
  method: "GET" as const,
  timeoutMs: 8_000,
  expectedStatus: { minimum: 200, maximum: 299 },
};

function response(statusCode: number, headers: CheckerResponse["headers"] = {}): CheckerResponse {
  return { statusCode, headers, body: { destroy: vi.fn() } };
}

function harness(executor: RequestExecutor, extra: Partial<CheckerDependencies> = {}) {
  const close = vi.fn(async () => undefined);
  const dispatcher = { close } as unknown as ManagedDispatcher;
  const createDispatcher = vi.fn(() => dispatcher);
  const checker = createHttpChecker({ request: executor, createDispatcher, ...extra });
  return { checker, close, createDispatcher };
}

describe("HTTP checker", () => {
  it("returns terminal response metadata and closes the origin dispatcher", async () => {
    const request = vi.fn(async () => response(204));
    const { checker, close, createDispatcher } = harness(request);
    const result = await checker(target);

    expect(result).toMatchObject({
      success: true,
      mode: "scheduled",
      method: "GET",
      requestedUrl: target.url,
      finalUrl: target.url,
      hostname: "example.com",
      statusCode: 204,
      redirectCount: 0,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(createDispatcher).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("follows only defined redirects and evaluates final status", async () => {
    const request = vi.fn<RequestExecutor>()
      .mockResolvedValueOnce(response(302, { location: "/next" }))
      .mockResolvedValueOnce(response(200));
    const { checker, createDispatcher } = harness(request);
    const result = await checker(target);

    expect(result).toMatchObject({ success: true, finalUrl: "https://example.com/next", redirectCount: 1 });
    expect(createDispatcher).toHaveBeenCalledTimes(1);
  });

  it("uses a separate dispatcher for each redirect origin", async () => {
    const request = vi.fn<RequestExecutor>()
      .mockResolvedValueOnce(response(301, { location: "https://www.example.org/" }))
      .mockResolvedValueOnce(response(200));
    const { checker, createDispatcher, close } = harness(request);
    const result = await checker(target);

    expect(result.success).toBe(true);
    expect(createDispatcher).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("gives missing or unsafe redirect destinations precedence over status validation", async () => {
    const missing = harness(async () => response(302));
    await expect(missing.checker(target)).resolves.toMatchObject({ errorCode: "INVALID_REDIRECT" });

    const blocked = harness(async () => response(302, { location: "http://127.0.0.1/admin" }));
    await expect(blocked.checker(target)).resolves.toMatchObject({ errorCode: "INVALID_REDIRECT" });
  });

  it("treats unlisted 3xx responses as terminal", async () => {
    const { checker } = harness(async () => response(304, { location: "/ignored" }));
    await expect(checker(target)).resolves.toMatchObject({ errorCode: "INVALID_STATUS", redirectCount: 0 });
  });

  it("stops after five followed redirects", async () => {
    const { checker } = harness(async () => response(302, { location: "/again" }));
    const result = await checker(target);
    expect(result).toMatchObject({ success: false, errorCode: "TOO_MANY_REDIRECTS", redirectCount: 5 });
  });

  it("validates the redirect destination before applying the redirect limit", async () => {
    let requestCount = 0;
    const { checker } = harness(async () => {
      requestCount += 1;
      return response(302, { location: requestCount === 6 ? "file:///blocked" : "/again" });
    });
    await expect(checker(target)).resolves.toMatchObject({
      errorCode: "INVALID_REDIRECT",
      redirectCount: 5,
    });
  });

  it("classifies stable transport failures through wrapped causes", async () => {
    const cases = [
      ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"],
      ["ENOTFOUND", "DNS_ERROR"],
      ["ECONNREFUSED", "CONNECTION_REFUSED"],
      ["ECONNRESET", "CONNECTION_RESET"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_ERROR"],
      ["UND_ERR_INVALID_ARG", "RESPONSE_ERROR"],
    ] as const;

    for (const [transportCode, checkCode] of cases) {
      const cause = Object.assign(new Error("transport"), { code: transportCode });
      const { checker } = harness(async () => { throw new TypeError("request failed", { cause }); });
      await expect(checker(target)).resolves.toMatchObject({ errorCode: checkCode });
    }
  });

  it("records the exact address selected by the socket lookup", async () => {
    let lookup: Parameters<NonNullable<CheckerDependencies["createDispatcher"]>>[0]["lookup"];
    const close = vi.fn(async () => undefined);
    const createDispatcher = vi.fn((options) => {
      lookup = options.lookup;
      return { close } as unknown as ManagedDispatcher;
    });
    const request: RequestExecutor = async () => {
      await new Promise<void>((resolve, reject) => lookup("example.com", {}, (error, address) => {
        if (error) reject(error);
        else {
          expect(address).toBe("8.8.8.8");
          resolve();
        }
      }));
      return response(200);
    };
    const checker = createHttpChecker({
      createDispatcher,
      request,
      resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    await expect(checker(target)).resolves.toMatchObject({ resolvedAddress: "8.8.8.8" });
  });

  it("reports blocked mixed DNS answers without making a successful request", async () => {
    let lookup: Parameters<NonNullable<CheckerDependencies["createDispatcher"]>>[0]["lookup"];
    const createDispatcher = vi.fn((options) => {
      lookup = options.lookup;
      return { close: async () => undefined } as unknown as ManagedDispatcher;
    });
    const request: RequestExecutor = async () => {
      await new Promise<void>((resolve, reject) => lookup("example.com", {}, (error) =>
        error ? reject(error) : resolve()));
      return response(200);
    };
    const checker = createHttpChecker({
      createDispatcher,
      request,
      resolveAll: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    });
    await expect(checker(target)).resolves.toMatchObject({ errorCode: "BLOCKED_TARGET" });
  });

  it("returns manual mode without changing checker semantics", async () => {
    const close = vi.fn(async () => undefined);
    const result = await runManualCheck("https://example.com", {}, {
      request: async () => response(200),
      createDispatcher: () => ({ close } as unknown as ManagedDispatcher),
    });
    expect(result).toMatchObject({ success: true, mode: "manual" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid target configuration before dispatch", async () => {
    const request = vi.fn(async () => response(200));
    const { checker, createDispatcher } = harness(request);
    await expect(checker({ ...target, url: "file:///etc/passwd" })).resolves.toMatchObject({
      errorCode: "INVALID_URL",
    });
    expect(request).not.toHaveBeenCalled();
    expect(createDispatcher).not.toHaveBeenCalled();
  });

  it("distinguishes a blocked literal from a malformed URL", async () => {
    const { checker } = harness(async () => response(200));
    await expect(checker({ ...target, url: "http://127.0.0.1" })).resolves.toMatchObject({
      errorCode: "BLOCKED_TARGET",
    });
  });
});
