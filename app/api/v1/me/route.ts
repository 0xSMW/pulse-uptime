import { apiJson, objectEnvelope } from "@/lib/api/envelopes";
import { serializePrincipal } from "@/lib/api/me";
import { authorize, isApiResponse } from "@/lib/api/middleware";

export async function GET(request: Request) {
  const context = await authorize(request);
  if (isApiResponse(context)) return context;
  return apiJson(objectEnvelope("Me", serializePrincipal(context.principal), context.requestId));
}
