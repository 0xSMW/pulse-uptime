import { monitorEnabledRoute } from "@/lib/api/monitor-http"

export const POST = monitorEnabledRoute({ enabled: true, routeKey: "resume" })
