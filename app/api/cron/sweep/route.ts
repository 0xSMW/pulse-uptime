import { runSweepCron } from "@/lib/maintenance/runtime";
import {
  CRON_RESPONSE_HEADERS,
  isAuthorizedCronRequest,
} from "@/lib/scheduler/authentication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: CRON_RESPONSE_HEADERS,
    });
  }
  const startedAt = Date.now();
  console.info(JSON.stringify({ event: "cron.started", jobName: "sweep" }));
  try {
    const summary = await runSweepCron();
    console[summary.loopAlert.unhealthy ? "warn" : "info"](JSON.stringify({
      event: "sweep.completed",
      jobName: "sweep",
      expired: summary.expired,
      monitoringLoopUnhealthy: summary.loopAlert.unhealthy,
      ...(summary.loopAlert.reason ? { monitoringLoopReason: summary.loopAlert.reason } : {}),
      alertsSent: summary.loopAlert.sentDirect,
      durationMs: Date.now() - startedAt,
    }));
    return new Response(JSON.stringify({ status: "completed", summary }), {
      status: 200,
      headers: CRON_RESPONSE_HEADERS,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "sweep.failed",
      jobName: "sweep",
      durationMs: Date.now() - startedAt,
    }));
    return new Response(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : "sweep failed" }), {
      status: 500,
      headers: CRON_RESPONSE_HEADERS,
    });
  }
}
