import { apiError, objectEnvelope, apiJson } from "@/lib/api/envelopes";
import { authorize, isApiResponse } from "@/lib/api/middleware";
import { operationalService } from "@/lib/api/operational-service";

export async function GET(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const context = await authorize(request, { scope: "incidents:read" });
  if (isApiResponse(context)) return context;
  const incident = await operationalService.findIncident((await params).incidentId);
  if (!incident) return apiError(context.requestId, 404, "INCIDENT_NOT_FOUND", "Incident was not found");
  return apiJson(objectEnvelope("Incident", incident, context.requestId));
}
