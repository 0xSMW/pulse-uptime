// Status.io public state adapter. Covers Neon. The public state endpoint
// gives credential-free current component and region status, but Neon's
// incident endpoints return 403, so this adapter never populates incidents
// or maintenances: it reports current state only and lets the catalog link
// to the provider's own page for incident detail. Unknown status strings
// fail parsing outright, per the doc's "unknown strings throw" rule, so a
// stale mapping cannot silently mislabel a component.

import { z } from "zod";

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";

import type { AdapterRequestDescriptor, DependencyAdapter, NormalizeInput } from "./index";
import { AdapterParseError, requireJson } from "./shared";

const containerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  updated: z.string(),
});

const componentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string(),
  updated: z.string(),
  containers: z.array(containerSchema).optional().default([]),
});

const statusDocSchema = z.object({
  result: z.object({
    status_overall: z.object({ updated: z.string(), status: z.string() }),
    status: z.array(componentSchema),
  }),
}).strict();

type ComponentState = "OPERATIONAL" | "DEGRADED" | "OUTAGE" | "MAINTENANCE";

/** Status.io's complete public documented vocabulary. Anything else fails parsing so a drifted mapping never mislabels a component. */
function mapStatusioStatus(status: string, sourceId: string): ComponentState {
  switch (status) {
    case "Operational":
      return "OPERATIONAL";
    case "Degraded Performance":
    case "Partial Service Disruption":
      return "DEGRADED";
    case "Service Disruption":
      return "OUTAGE";
    case "Planned Maintenance":
    case "Emergency Maintenance":
      return "MAINTENANCE";
    default:
      throw new AdapterParseError("UNKNOWN_STATUS", `${sourceId}: unrecognized Status.io status "${status}"`);
  }
}

export const statusioPublicAdapter: DependencyAdapter = {
  requests(source: DependencySourceManifest): AdapterRequestDescriptor[] {
    return [{ kind: "current", url: source.currentUrl, optional: false }];
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;
    const json = requireJson(documents[0], source.id, "status");
    const parsed = statusDocSchema.safeParse(json);
    if (!parsed.success) {
      throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: status document failed schema validation: ${parsed.error.message}`);
    }
    const { result } = parsed.data;

    const components: NormalizedProviderSnapshot["components"] = {};
    for (const component of result.status) {
      components[component.id] = { state: mapStatusioStatus(component.status, source.id), updatedAt: component.updated };
      for (const container of component.containers) {
        components[container.id] = { state: mapStatusioStatus(container.status, source.id), updatedAt: container.updated };
      }
    }

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt: result.status_overall.updated,
      componentsComplete: true,
      components,
      // Neon's incident endpoints return 403: no incident titles are invented from current state alone.
      incidents: [],
      maintenances: [],
      cache: { etag: null, lastModified: null },
    };
  },
};
