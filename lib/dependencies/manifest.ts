import { z } from "zod";

import catalogJson from "./catalog.json";

const dependencyAdapterSchema = z.enum([
  "statuspage_v2",
  "incidentio_compat",
  "google_cloud_status",
  "statusio_public",
  "sorry_v1",
]);

const dependencyCategorySchema = z.enum(["ai", "hosting", "auth", "data", "payments", "developer"]);

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
  config: z.record(z.string(), z.unknown()),
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
