import { Agent, request as undiciRequest } from "undici";

import { classifyCheckError, ERROR_MESSAGES } from "./classify-error";
import { assertPublicAddress, isIpLiteral, normalizeIpLiteral } from "./ip-policy";
import { createSecureLookup, systemResolveAll, type ResolveAll, type SecureLookup } from "./secure-lookup";
import type {
  CheckErrorCode,
  CheckMode,
  CheckResult,
  CheckTarget,
  CheckerResponse,
  ManagedDispatcher,
  RequestExecutor,
} from "./types";
import { parsePublicHttpUrl, validateCheckTarget } from "./validation";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "Pulse-Uptime/1.0";

export type DispatcherFactory = (options: {
  origin: string;
  lookup: SecureLookup;
  connectTimeoutMs: number;
}) => ManagedDispatcher;

export type CheckerDependencies = {
  resolveAll?: ResolveAll;
  request?: RequestExecutor;
  createDispatcher?: DispatcherFactory;
  now?: () => number;
  userAgent?: string;
};

const defaultRequest: RequestExecutor = async (url, options) =>
  undiciRequest(url, options) as Promise<CheckerResponse>;

const defaultDispatcherFactory: DispatcherFactory = ({ lookup, connectTimeoutMs }) =>
  new Agent({
    connect: { lookup, timeout: connectTimeoutMs },
    connections: 1,
    pipelining: 0,
  });

function headerValue(headers: CheckerResponse["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function failure(
  metadata: Omit<CheckResult, "success" | "errorCode" | "errorMessage">,
  errorCode: CheckErrorCode,
): CheckResult {
  return { ...metadata, success: false, errorCode, errorMessage: ERROR_MESSAGES[errorCode] };
}

export function createHttpChecker(dependencies: CheckerDependencies = {}) {
  const resolveAll = dependencies.resolveAll ?? systemResolveAll;
  const executeRequest = dependencies.request ?? defaultRequest;
  const createDispatcher = dependencies.createDispatcher ?? defaultDispatcherFactory;
  const now = dependencies.now ?? Date.now;
  const userAgent = dependencies.userAgent ?? DEFAULT_USER_AGENT;

  return async function check(
    input: CheckTarget,
    options: { mode?: CheckMode } = {},
  ): Promise<CheckResult> {
    const mode = options.mode ?? "scheduled";
    const startedAt = now();
    let currentUrl: URL;
    let method = input.method;
    let redirects = 0;
    let statusCode: number | null = null;
    let resolvedAddress: string | null = null;
    const dispatchers = new Map<string, ManagedDispatcher>();
    const selectedAddresses = new Map<string, string>();

    const metadata = () => ({
      mode,
      method,
      requestedUrl: input.url,
      finalUrl: currentUrl?.href ?? input.url,
      hostname: currentUrl?.hostname ?? "",
      resolvedAddress,
      statusCode,
      latencyMs: Math.max(0, now() - startedAt),
      redirectCount: redirects,
    });

    try {
      // Parse first so a blocked literal retains BLOCKED_TARGET rather than being
      // flattened into an ordinary schema-validation failure.
      currentUrl = parsePublicHttpUrl(input.url);
      const target = validateCheckTarget(input);

      while (true) {
        const remaining = target.timeoutMs - (now() - startedAt);
        if (remaining <= 0) return failure(metadata(), "TIMEOUT");

        const origin = currentUrl.origin;
        let dispatcher = dispatchers.get(origin);
        if (!dispatcher) {
          if (isIpLiteral(currentUrl.hostname)) {
            const literal = normalizeIpLiteral(currentUrl.hostname);
            assertPublicAddress(literal);
            resolvedAddress = literal;
            selectedAddresses.set(origin, literal);
          }
          const lookup = createSecureLookup({
            resolveAll,
            onAddressSelected: ({ address }) => {
              selectedAddresses.set(origin, address);
              resolvedAddress = address;
            },
          });
          dispatcher = createDispatcher({ origin, lookup, connectTimeoutMs: remaining });
          dispatchers.set(origin, dispatcher);
        } else {
          resolvedAddress = selectedAddresses.get(origin) ?? null;
        }

        let response: CheckerResponse;
        try {
          response = await executeRequest(currentUrl, {
            method,
            dispatcher,
            signal: AbortSignal.timeout(remaining),
            headersTimeout: remaining,
            bodyTimeout: remaining,
            maxRedirections: 0,
            headers: { "user-agent": userAgent },
          });
        } catch (error) {
          return failure(metadata(), classifyCheckError(error));
        }

        statusCode = response.statusCode;
        response.body.destroy();

        if (REDIRECT_STATUSES.has(statusCode)) {
          const location = headerValue(response.headers, "location");
          if (!location) return failure(metadata(), "INVALID_REDIRECT");

          let destination: URL;
          try {
            destination = parsePublicHttpUrl(new URL(location, currentUrl).href);
          } catch {
            return failure(metadata(), "INVALID_REDIRECT");
          }
          if (redirects >= MAX_REDIRECTS) return failure(metadata(), "TOO_MANY_REDIRECTS");

          redirects += 1;
          if (statusCode === 303 && method !== "HEAD") method = "GET";
          currentUrl = destination;
          continue;
        }

        if (statusCode < target.expectedStatus.minimum || statusCode > target.expectedStatus.maximum) {
          return failure(metadata(), "INVALID_STATUS");
        }

        return { ...metadata(), success: true, errorCode: null, errorMessage: null };
      }
    } catch (error) {
      return failure(metadata(), classifyCheckError(error));
    } finally {
      await Promise.allSettled([...dispatchers.values()].map((dispatcher) => dispatcher.close()));
    }
  };
}

export const checkHttpEndpoint = createHttpChecker();

export function checkMonitor(target: CheckTarget, dependencies?: CheckerDependencies) {
  return createHttpChecker(dependencies)(target, { mode: "scheduled" });
}

export function runManualCheck(
  url: string,
  options: Partial<Omit<CheckTarget, "url">> & { userAgent?: string } = {},
  dependencies: CheckerDependencies = {},
) {
  return createHttpChecker({ ...dependencies, userAgent: options.userAgent ?? dependencies.userAgent })(
    {
      url,
      method: options.method ?? "GET",
      timeoutMs: options.timeoutMs ?? 8_000,
      expectedStatus: options.expectedStatus ?? { minimum: 200, maximum: 399 },
    },
    { mode: "manual" },
  );
}
