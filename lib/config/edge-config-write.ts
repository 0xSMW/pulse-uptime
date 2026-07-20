import "server-only";

import type { MonitoringConfig } from "@/lib/config";

// One PATCH against the Vercel Edge Config items API, upserting the "monitoring"
// key. The 8000ms timeout bounds the external call. The parsed store version is
// returned when Vercel reports it, otherwise null. Callers map thrown failures
// to their own error types, so this throws a plain Error on misconfiguration,
// network failure, and non-2xx responses alike.
export async function writeMonitoringEdgeConfig(config: MonitoringConfig): Promise<number | null> {
  const configId = process.env.EDGE_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  if (!configId || !token) throw new Error("Edge Config is unavailable");
  const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
  const response = await fetch(`https://api.vercel.com/v1/edge-config/${encodeURIComponent(configId)}/items${teamQuery}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ operation: "upsert", key: "monitoring", value: config }] }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Edge Config write failed");
  const versionHeader = response.headers.get("x-vercel-edge-config-version");
  return versionHeader && /^\d+$/.test(versionHeader) ? Number(versionHeader) : null;
}
