import { runAtomicMutation } from "@/lib/api/atomic-mutation"
import { apiError, apiJson, listEnvelope } from "@/lib/api/envelopes"
import { authorize, isApiResponse } from "@/lib/api/middleware"
import { monitorError, storedMonitorError } from "@/lib/api/monitor-http"
import { createMonitor, listMonitors } from "@/lib/api/monitors"
import { pageLimit } from "@/lib/api/pagination"
import { routeError } from "@/lib/api/route"

export async function GET(request: Request) {
  const context = await authorize(request, { scope: "monitors:read" })
  if (isApiResponse(context)) {
    return context
  }
  const search = new URL(request.url).searchParams
  const limit = pageLimit(search.get("limit"))
  if (!limit) {
    return apiError(
      context.requestId,
      400,
      "INVALID_REQUEST",
      "Limit must be between 1 and 100"
    )
  }
  const state = search.get("state")?.toUpperCase()
  const states = [
    "DOWN",
    "VERIFYING_DOWN",
    "VERIFYING_UP",
    "PENDING",
    "UP",
    "PAUSED",
    "ARCHIVED",
  ] as const
  if (state && !states.includes(state as (typeof states)[number])) {
    return apiError(
      context.requestId,
      400,
      "INVALID_REQUEST",
      "State filter is invalid"
    )
  }
  const enabledValue = search.get("enabled")
  if (
    enabledValue !== null &&
    enabledValue !== "true" &&
    enabledValue !== "false"
  ) {
    return apiError(
      context.requestId,
      400,
      "INVALID_REQUEST",
      "Enabled filter is invalid"
    )
  }
  const sortValue = search.get("sort") ?? "state"
  const sorts = ["state", "name", "id"] as const
  if (!sorts.includes(sortValue as (typeof sorts)[number])) {
    return apiError(
      context.requestId,
      400,
      "INVALID_REQUEST",
      "Sort is invalid"
    )
  }
  if (search.has("group") && search.has("groupId")) {
    return apiError(
      context.requestId,
      400,
      "INVALID_REQUEST",
      "Use either group or groupId"
    )
  }
  try {
    const result = await listMonitors({
      cursor: search.get("cursor"),
      limit,
      state: state as (typeof states)[number] | undefined,
      group: search.get("group") ?? undefined,
      groupId: search.get("groupId") ?? undefined,
      enabled: enabledValue === null ? undefined : enabledValue === "true",
      sort: sortValue as (typeof sorts)[number],
    })
    return apiJson(
      listEnvelope(
        "MonitorList",
        result.monitors,
        context.requestId,
        result.nextCursor
      )
    )
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}

export async function POST(request: Request) {
  const context = await authorize(request, { scope: "monitors:write" })
  if (isApiResponse(context)) {
    return context
  }
  try {
    const body = await request.json()
    return runAtomicMutation({
      request,
      context,
      routeKey: "/api/v1/monitors",
      body,
      work: async (tx) => ({
        status: 201,
        kind: "Monitor",
        data: await createMonitor(body, context.principalKey, tx),
      }),
      storedError: storedMonitorError,
      mapError: monitorError,
    })
  } catch (error) {
    return (
      monitorError(error, context.requestId) ??
      routeError(error, context.requestId)
    )
  }
}
