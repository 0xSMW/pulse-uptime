import {
  apiJson,
  latestCliVersion,
  minimumCliVersion,
  objectEnvelope,
  requestIdFrom,
} from "@/lib/api/envelopes";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  return apiJson(
    objectEnvelope(
      "Version",
      {
        supportedApiVersions: ["v1"],
        minimumCliVersion: minimumCliVersion(),
        latestCliVersion: latestCliVersion(),
      },
      requestId,
    ),
  );
}
