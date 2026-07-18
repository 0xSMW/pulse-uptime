import type { Dispatcher } from "undici";

export const CHECK_ERROR_CODES = [
  "TIMEOUT",
  "DNS_ERROR",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "TLS_ERROR",
  "TOO_MANY_REDIRECTS",
  "INVALID_REDIRECT",
  "INVALID_STATUS",
  "BLOCKED_TARGET",
  "INVALID_URL",
  "RESPONSE_ERROR",
  "UNKNOWN",
] as const;

export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];
export type CheckMethod = "GET" | "HEAD";
export type CheckMode = "scheduled" | "manual";

export type CheckTarget = {
  url: string;
  method: CheckMethod;
  timeoutMs: number;
  expectedStatus: { minimum: number; maximum: number };
};

export type MonitorConfig = CheckTarget & {
  id: string;
  name: string;
  enabled: boolean;
  group: string | null;
  intervalMinutes: 1 | 5 | 10 | 15;
  failureThreshold: number;
  recoveryThreshold: number;
  recipients: string[];
};

export type CheckMetadata = {
  mode: CheckMode;
  method: CheckMethod;
  requestedUrl: string;
  finalUrl: string;
  hostname: string;
  resolvedAddress: string | null;
  statusCode: number | null;
  latencyMs: number;
  redirectCount: number;
};

export type CheckResult =
  | (CheckMetadata & { success: true; errorCode: null; errorMessage: null })
  | (CheckMetadata & {
      success: false;
      errorCode: CheckErrorCode;
      errorMessage: string;
    });

export type ResponseBody = { destroy(error?: Error): void };
export type CheckerResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: ResponseBody;
};

export type RequestExecutor = (
  url: URL,
  options: {
    method: CheckMethod;
    dispatcher: Dispatcher;
    signal: AbortSignal;
    headersTimeout: number;
    bodyTimeout: number;
    maxRedirections: 0;
    headers: Record<string, string>;
  },
) => Promise<CheckerResponse>;

export type ManagedDispatcher = Dispatcher & {
  close(): Promise<void>;
};
