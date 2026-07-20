import { z } from "zod";

import catalogJson from "./catalog.json";
import { MAX_BODY_BYTES_CEILING } from "./types";

const dependencyAdapterSchema = z.enum([
  "statuspage_v2",
  "incidentio_compat",
  "google_cloud_status",
  "statusio_public",
  "sorry_v1",
  "aws_health",
  "nextdata_embedded",
  "incident_feed",
  "auth0_status",
]);

const dependencyCategorySchema = z.enum(["ai", "hosting", "auth", "data", "payments", "developer"]);

const dependencyFidelitySchema = z.enum(["component", "incident_only"]);

const componentIdsSelectorSchema = z.object({
  kind: z.literal("component_ids"),
  aggregation: z.literal("worst_of"),
  ids: z.array(z.string().min(1)),
}).strict();

const googleProductSelectorSchema = z.object({
  kind: z.literal("google_product"),
  productId: z.string().min(1),
  location: z.object({ required: z.boolean() }).strict().optional(),
}).strict();

const statusioComponentContainerSelectorSchema = z.object({
  kind: z.literal("statusio_component_container"),
  componentId: z.string().min(1),
  container: z.object({ required: z.boolean() }).strict(),
}).strict();

const selectorSchema = z.discriminatedUnion("kind", [
  componentIdsSelectorSchema,
  googleProductSelectorSchema,
  statusioComponentContainerSelectorSchema,
]);

const scopeOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
}).strict();

const requiredOptionsScopeSchema = z.object({
  kind: z.literal("required_options"),
  options: z.array(scopeOptionSchema).min(1),
}).strict();

const discoveredChildrenScopeSchema = z.object({
  kind: z.literal("discovered_children"),
  groupId: z.string().min(1),
  required: z.boolean(),
}).strict();

const discoveredLocationsScopeSchema = z.object({
  kind: z.literal("discovered_locations"),
  required: z.boolean(),
}).strict();

const scopeSchema = z.discriminatedUnion("kind", [
  requiredOptionsScopeSchema,
  discoveredChildrenScopeSchema,
  discoveredLocationsScopeSchema,
]).nullable();

const sourceSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  adapter: dependencyAdapterSchema,
  currentUrl: z.string().url(),
  incidentsUrl: z.string().url().nullable(),
  statusPageUrl: z.string().url(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  operationalPollSeconds: z.number().int().positive(),
  activePollSeconds: z.number().int().positive(),
  staleAfterSeconds: z.number().int().positive(),
  // config carries adapter-specific keys (Google's productsUrl, Status.io
  // paths, Sorry pagination hints) so it stays an open record. The one field
  // the fetch layer reads out of it, maxBodyBytes, is range checked in
  // validateManifestInvariants so config's type stays a plain record and
  // never fights the Record<string, unknown> the poller reconstructs.
  config: z.record(z.string(), z.unknown()),
  // Source-level fidelity, inherited by every preset that does not override
  // it. Omitted means "component". An incident_only source (an RSS incident
  // feed, an embedded SSR payload with no component health) advertises that
  // its state comes from incident prose, never a normalized component reading.
  fidelity: dependencyFidelitySchema.optional(),
}).strict();

const presetSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  name: z.string().min(1),
  category: dependencyCategorySchema,
  description: z.string().min(1),
  selector: selectorSchema,
  scope: scopeSchema,
  sourceScopeNote: z.string().min(1).nullable(),
  // Per-preset fidelity override. Omitted means "inherit the source's
  // fidelity". A component-fidelity source can still host an incident_only
  // preset, and vice versa, so the override lives here rather than only on the
  // source. Effective fidelity is resolved at catalog sync as
  // preset.fidelity ?? source.fidelity ?? "component".
  fidelity: dependencyFidelitySchema.optional(),
  enabled: z.boolean(),
}).strict();

function urlHost(url: string): string {
  return new URL(url).hostname;
}

function validateManifestInvariants(
  manifest: { sources: Array<z.infer<typeof sourceSchema>>; presets: Array<z.infer<typeof presetSchema>> },
  context: z.RefinementCtx,
): void {
  const sourceIds = new Set<string>();
  manifest.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      context.addIssue({ code: "custom", message: `Duplicate source id "${source.id}"`, path: ["sources", index, "id"] });
    }
    sourceIds.add(source.id);

    const urls = [source.currentUrl, source.statusPageUrl, ...(source.incidentsUrl ? [source.incidentsUrl] : [])];
    urls.forEach((url) => {
      const host = urlHost(url);
      if (!source.allowedHosts.includes(host)) {
        context.addIssue({
          code: "custom",
          message: `allowedHosts must include "${host}" for URL "${url}"`,
          path: ["sources", index, "allowedHosts"],
        });
      }
    });

    // maxBodyBytes may raise the 512 KB default up to the 4 MB ceiling and no
    // higher. Checked here rather than in the config schema so config stays a
    // plain record. The fetch layer also clamps at read time, this is the
    // build-time guard so a manifest can never ship an over-large cap.
    const maxBodyBytes = source.config.maxBodyBytes;
    if (maxBodyBytes !== undefined) {
      if (typeof maxBodyBytes !== "number" || !Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES_CEILING) {
        context.addIssue({
          code: "custom",
          message: `config.maxBodyBytes must be a positive integer no greater than ${MAX_BODY_BYTES_CEILING}`,
          path: ["sources", index, "config", "maxBodyBytes"],
        });
      }
    }
  });

  const presetIds = new Set<string>();
  manifest.presets.forEach((preset, index) => {
    if (presetIds.has(preset.id)) {
      context.addIssue({ code: "custom", message: `Duplicate preset id "${preset.id}"`, path: ["presets", index, "id"] });
    }
    presetIds.add(preset.id);

    if (!sourceIds.has(preset.sourceId)) {
      context.addIssue({
        code: "custom",
        message: `Preset "${preset.id}" references unknown source "${preset.sourceId}"`,
        path: ["presets", index, "sourceId"],
      });
    }
  });
}

export const catalogManifestSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().min(1),
  sources: z.array(sourceSchema),
  presets: z.array(presetSchema),
}).strict().superRefine(validateManifestInvariants);

export type DependencySourceManifest = z.infer<typeof sourceSchema>;
export type DependencyPresetManifest = z.infer<typeof presetSchema>;
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;

/** Parses and validates the shipped catalog.json. Throws on any schema or invariant violation. */
export function loadCatalogManifest(): CatalogManifest {
  return catalogManifestSchema.parse(catalogJson);
}
