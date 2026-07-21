import { monitorEnabledRoute } from "@/lib/api/monitor-http"

export const POST = monitorEnabledRoute({ enabled: false, routeKey: "pause" })
