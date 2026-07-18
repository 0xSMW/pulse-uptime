import { createClient } from "@vercel/edge-config";
import { Resend } from "resend";
import type { ReadinessResult } from "./types";
import { withTimeout } from "./service";

const PROBE_TIMEOUT_MS = 8_000;

type DatabaseProbe = () => Promise<void>;

type ResendProbeClient = Pick<Resend, "domains" | "emails">;

export function createVercelProbe(
  env: Record<string, string | undefined> = process.env,
): () => Promise<ReadinessResult> {
  return async () => {
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    const required = [
      env.CRON_SECRET,
      env.EDGE_CONFIG,
      env.EDGE_CONFIG_ID,
      env.VERCEL_API_TOKEN,
    ];

    const secureUrl = (() => {
      try {
        return appUrl ? new URL(appUrl).protocol === "https:" : false;
      } catch {
        return false;
      }
    })();

    if (!secureUrl || required.some((value) => !value)) {
      return blocked(
        "vercel",
        "VERCEL_CONFIGURATION_INCOMPLETE",
        "Complete the Vercel environment setup",
      );
    }

    return ready("vercel", "VERCEL_READY");
  };
}

export function createDatabaseProbe(
  probe: DatabaseProbe,
): () => Promise<ReadinessResult> {
  return () =>
    withTimeout(
      probe().then(() => ready("database", "DATABASE_READY")),
      PROBE_TIMEOUT_MS,
      blocked(
        "database",
        "DATABASE_TIMEOUT",
        "Check Neon connectivity and migrations",
      ),
    ).catch(() =>
      blocked(
        "database",
        "DATABASE_UNAVAILABLE",
        "Connect Neon and run migrations",
      ),
    );
}

export function createEdgeConfigProbe(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): () => Promise<ReadinessResult> {
  return async () => {
    const connection = env.EDGE_CONFIG;
    const configId = env.EDGE_CONFIG_ID;
    const token = env.VERCEL_API_TOKEN;
    if (!connection || !configId || !token) {
      return blocked(
        "edge",
        "EDGE_CONFIGURATION_INCOMPLETE",
        "Connect a writable Edge Config store",
      );
    }

    try {
      const client = createClient(connection);
      const items = await withTimeout(client.getAll(), PROBE_TIMEOUT_MS, null);
      if (!items) throw new Error("Edge Config read timed out");

      const current = items.monitoring ?? initialMonitoringConfig();
      const teamQuery = env.VERCEL_TEAM_ID
        ? `?teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}`
        : "";
      const response = await withTimeout(
        fetcher(
          `https://api.vercel.com/v1/edge-config/${encodeURIComponent(configId)}/items${teamQuery}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              items: [
                {
                  operation: "upsert",
                  key: "monitoring",
                  value: current,
                },
              ],
            }),
          },
        ),
        PROBE_TIMEOUT_MS,
        null,
      );
      if (!response?.ok) throw new Error("Edge Config write failed");
      return ready("edge", "EDGE_READY");
    } catch {
      return blocked(
        "edge",
        "EDGE_UNAVAILABLE",
        "Check Edge Config read and write access",
      );
    }
  };
}

export function createEmailProbe(
  env: Record<string, string | undefined> = process.env,
  createClient: (apiKey: string) => ResendProbeClient = (apiKey) => new Resend(apiKey),
): () => Promise<ReadinessResult> {
  return async () => {
    const key = env.RESEND_API_KEY;
    const from = env.RESEND_FROM_EMAIL;
    if (!key || !from) return emailWarning("EMAIL_CONFIGURATION_INCOMPLETE");

    try {
      const domain = from.split("@")[1]?.toLowerCase();
      if (!domain) return emailWarning("EMAIL_SENDER_INVALID");
      const resend = createClient(key);
      const result = await withTimeout(
        resend.domains.list(),
        PROBE_TIMEOUT_MS,
        null,
      );
      if (!result) return emailWarning("EMAIL_API_UNAVAILABLE");
      if (result.error) {
        const delivery = await withTimeout(
          resend.emails.send(
            {
              from,
              to: "delivered@resend.dev",
              subject: "Pulse email readiness check",
              text: "Pulse verified this sender for outage and recovery alerts.",
            },
            { idempotencyKey: `pulse-readiness-${domain}` },
          ),
          PROBE_TIMEOUT_MS,
          null,
        );
        return delivery && !delivery.error
          ? ready("email", "EMAIL_READY")
          : emailWarning("EMAIL_API_UNAVAILABLE");
      }
      const verified = result.data?.data.some(
        (entry) =>
          entry.name.toLowerCase() === domain && entry.status === "verified",
      );
      return verified
        ? ready("email", "EMAIL_READY")
        : emailWarning("EMAIL_DOMAIN_UNVERIFIED");
    } catch {
      return emailWarning("EMAIL_API_UNAVAILABLE");
    }
  };
}

function initialMonitoringConfig() {
  return {
    schemaVersion: 1,
    configVersion: 1,
    settings: {
      concurrency: 5,
      defaultTimeoutMs: 8_000,
      defaultFailureThreshold: 2,
      defaultRecoveryThreshold: 2,
      defaultRecipients: [],
      userAgent: "Pulse/1.0",
    },
    monitors: [],
  };
}

function ready(
  system: ReadinessResult["system"],
  code: string,
): ReadinessResult {
  return { system, state: "ready", code };
}

function blocked(
  system: ReadinessResult["system"],
  code: string,
  remediation: string,
): ReadinessResult {
  return { system, state: "blocked", code, remediation };
}

function emailWarning(code: string): ReadinessResult {
  return {
    system: "email",
    state: "warning",
    code,
    remediation: "Verify your Resend sender",
  };
}
