import { runSweepCron } from "@/lib/maintenance/runtime";
import { getPulseReleaseId } from "@/lib/release/id";
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
  const releaseId = getPulseReleaseId();
  console.info(JSON.stringify({
    event: "cron.started",
    jobName: "sweep",
    releaseId,
  }));
  try {
    const summary = await runSweepCron();
    const { loopAlert, systemAlertDelivery } = summary;
    // Enqueue and delivery summaries are logged as distinct fields so an
    // operator can see whether work was created this sweep versus claimed and
    // advanced by the outbox state machine.
    console[loopAlert.unhealthy ? "warn" : "info"](JSON.stringify({
      event: "sweep.completed",
      jobName: "sweep",
      releaseId,
      expired: summary.expired,
      monitoringLoopUnhealthy: loopAlert.unhealthy,
      ...(loopAlert.reason ? { monitoringLoopReason: loopAlert.reason } : {}),
      failures: loopAlert.failures,
      enqueued: loopAlert.enqueued,
      staleClaims: systemAlertDelivery.staleClaimsReconciled,
      claimed: systemAlertDelivery.claimed,
      sent: systemAlertDelivery.sent,
      failed: systemAlertDelivery.failed,
      dead: systemAlertDelivery.dead,
      lostClaims: systemAlertDelivery.lostClaims,
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
      releaseId,
      durationMs: Date.now() - startedAt,
    }));
    return new Response(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : "sweep failed" }), {
      status: 500,
      headers: CRON_RESPONSE_HEADERS,
    });
  }
}
