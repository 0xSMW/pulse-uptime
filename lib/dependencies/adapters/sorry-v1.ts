// Sorry (Postmark's status API) adapter. Components and the present,
// unplanned notice list can each span multiple pages. The past, unplanned
// notice list is fetched too, across a small bounded number of pages, so a
// notice that ends between polls and slides onto a deeper past page still
// surfaces its ended_at in the snapshot instead of vanishing unresolved. A notice's
// impacted components and full update history only come from its own detail
// document, fetched the same way whether the notice came from the present
// list or the past list. requests() is called repeatedly: once with no
// prior documents to get the first page of each list, and again with
// everything fetched so far so it can ask for whatever pagination or
// per-notice detail is still missing.

import { z } from "zod";

import type { DependencySourceManifest } from "../manifest";
import type { NormalizedProviderSnapshot } from "../types";
import { scopeFromComponentIds } from "../types";

import type { AdapterDocument, AdapterRequestDescriptor, CatalogDirectoryInput, DependencyAdapter, NormalizeInput } from "./index";
import { catalogDirectoryFromNormalize } from "./shared";
import { AdapterParseError, documentsOfKind, latestTimestamp, requireIsoTimestamp, requireProviderIncidentState, toBoundedPlainText } from "./shared";

const componentSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  state: z.string(),
  updated_at: z.string().nullable().optional(),
});

const pageMetaSchema = z.object({
  count: z.number(),
  total_count: z.number(),
  next_page: z.string().nullable().optional(),
});

const componentsDocSchema = z.object({
  components: z.array(componentSchema),
  meta: pageMetaSchema,
}).strict();

const noticeSummarySchema = z.object({
  id: z.number().int(),
  type: z.string(),
  state: z.string(),
  timeline_state: z.string().optional(),
});

const noticesListDocSchema = z.object({
  notices: z.array(noticeSummarySchema),
  meta: pageMetaSchema,
}).strict();

const noticeUpdateSchema = z.object({
  id: z.number().int(),
  state: z.string(),
  content: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

// The past list is followed for at most this many pages. The adapter carries no
// state across polls, so it cannot target the specific ended notices it wants,
// it instead fetches a small window wide enough to cover the notices that
// resolve within the gap between two polls. Sorry orders the past list by most
// recent first, so a just-ended notice lands near the front. This bound stays
// finite on its own, independent of the poller's per-source pagination round cap.
const PAST_LIST_MAX_PAGES = 3;

const noticeDetailComponentSchema = z.object({ id: z.number().int() });

const noticeDetailDocSchema = z.object({
  notice: z.object({
    id: z.number().int(),
    type: z.string(),
    state: z.string(),
    subject: z.string().min(1),
    url: z.string().nullable().optional(),
    began_at: z.string().nullable().optional(),
    ended_at: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    components: z.array(noticeDetailComponentSchema).optional().default([]),
    updates: z.array(noticeUpdateSchema).optional().default([]),
  }),
}).strict();

type ComponentState = "OPERATIONAL" | "DEGRADED" | "MAINTENANCE";

/** Sorry's complete component vocabulary per the doc: operational, degraded, under_maintenance. */
function mapComponentState(state: string, sourceId: string): ComponentState {
  switch (state) {
    case "operational":
      return "OPERATIONAL";
    case "degraded":
      return "DEGRADED";
    case "under_maintenance":
      return "MAINTENANCE";
    default:
      throw new AdapterParseError("UNKNOWN_STATUS", `${sourceId}: unrecognized component state "${state}"`);
  }
}

function componentsUrlOf(source: DependencySourceManifest): string {
  const value = source.config.componentsUrl;
  if (typeof value !== "string") {
    throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: config.componentsUrl is required for sorry_v1`);
  }
  return value;
}

function noticeDetailUrlOf(source: DependencySourceManifest, noticeId: number): string {
  const template = source.config.noticeDetailUrlTemplate;
  if (typeof template !== "string") {
    throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: config.noticeDetailUrlTemplate is required for sorry_v1`);
  }
  return template.replace("{id}", String(noticeId));
}

function unplannedNoticesUrl(source: DependencySourceManifest, timelineState: "present" | "past"): string {
  if (!source.incidentsUrl) {
    throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: incidentsUrl is required for sorry_v1`);
  }
  const url = new URL(source.incidentsUrl);
  url.searchParams.set("filter[timeline_state_eq]", timelineState);
  url.searchParams.set("filter[type_eq]", "unplanned");
  return url.toString();
}

function presentUnplannedNoticesUrl(source: DependencySourceManifest): string {
  return unplannedNoticesUrl(source, "present");
}

/** The seed URL of the past list. Its first page, plus a bounded run of following pages, observes the ended_at of notices that resolved since the prior poll. */
function pastUnplannedNoticesUrl(source: DependencySourceManifest): string {
  return unplannedNoticesUrl(source, "past");
}

function resolveNextPage(nextPage: string | null | undefined, base: string): string | null {
  if (!nextPage) return null;
  return new URL(nextPage, base).toString();
}

/** Best-effort peek used only to plan follow-up requests; normalize() re-parses strictly and is the source of truth. */
function peekComponentsMeta(document: AdapterDocument): z.infer<typeof pageMetaSchema> | null {
  const parsed = componentsDocSchema.safeParse(document.json);
  return parsed.success ? parsed.data.meta : null;
}

function peekNoticesList(document: AdapterDocument): z.infer<typeof noticesListDocSchema> | null {
  const parsed = noticesListDocSchema.safeParse(document.json);
  return parsed.success ? parsed.data : null;
}

function isNoticeDetailDocument(document: AdapterDocument): boolean {
  return noticeDetailDocSchema.safeParse(document.json).success;
}

/**
 * The past-list page URLs fetched so far, in fetch order, found by following
 * next_page from the past seed. A page stays identified as past by its position
 * in this chain even when its own next_page link drops the timeline_state
 * filter, which real next_page links can do.
 */
function fetchedPastListPages(source: DependencySourceManifest, fetchedSoFar: AdapterDocument[]): string[] {
  const listByUrl = new Map<string, z.infer<typeof noticesListDocSchema>>();
  for (const document of documentsOfKind(fetchedSoFar, "incidents")) {
    const list = peekNoticesList(document);
    if (list) listByUrl.set(document.url, list);
  }
  const chain: string[] = [];
  let url: string | null = pastUnplannedNoticesUrl(source);
  while (url && listByUrl.has(url) && !chain.includes(url)) {
    chain.push(url);
    url = resolveNextPage(listByUrl.get(url)!.meta.next_page, url);
  }
  return chain;
}

export const sorryV1Adapter: DependencyAdapter = {
  requests(source: DependencySourceManifest, fetchedSoFar?: AdapterDocument[]): AdapterRequestDescriptor[] {
    if (!fetchedSoFar || fetchedSoFar.length === 0) {
      return [
        { kind: "current", url: componentsUrlOf(source), optional: false },
        { kind: "incidents", url: presentUnplannedNoticesUrl(source), optional: false },
        { kind: "incidents", url: pastUnplannedNoticesUrl(source), optional: false },
      ];
    }

    const fetchedUrls = new Set(fetchedSoFar.map((document) => document.url));
    const next: AdapterRequestDescriptor[] = [];

    for (const document of documentsOfKind(fetchedSoFar, "current")) {
      const meta = peekComponentsMeta(document);
      const nextUrl = meta ? resolveNextPage(meta.next_page, document.url) : null;
      if (nextUrl && !fetchedUrls.has(nextUrl)) next.push({ kind: "current", url: nextUrl, optional: false });
    }

    const pastListPages = fetchedPastListPages(source, fetchedSoFar);
    for (const document of documentsOfKind(fetchedSoFar, "incidents")) {
      const list = peekNoticesList(document);
      if (!list) continue;
      // The present list is followed to completion. The past list is followed only
      // up to PAST_LIST_MAX_PAGES, enough to observe notices that resolved between
      // polls without an unbounded walk of historical notices.
      const pastPageIndex = pastListPages.indexOf(document.url);
      const isPastList = pastPageIndex !== -1;
      const followNextPage = !isPastList || pastPageIndex < PAST_LIST_MAX_PAGES - 1;
      const nextUrl = followNextPage ? resolveNextPage(list.meta.next_page, document.url) : null;
      if (nextUrl && !fetchedUrls.has(nextUrl)) next.push({ kind: "incidents", url: nextUrl, optional: false });
      for (const notice of list.notices) {
        if (notice.type !== "unplanned") continue;
        const detailUrl = noticeDetailUrlOf(source, notice.id);
        if (!fetchedUrls.has(detailUrl)) next.push({ kind: "incidents", url: detailUrl, optional: false });
      }
    }

    return next;
  },

  catalogDirectory(input: CatalogDirectoryInput) {
    return catalogDirectoryFromNormalize(sorryV1Adapter, input);
  },

  normalize(input: NormalizeInput): NormalizedProviderSnapshot {
    const { source, documents, observedAt } = input;

    const currentDocuments = documentsOfKind(documents, "current");
    if (currentDocuments.length === 0) {
      throw new AdapterParseError("MISSING_DOCUMENT", `${source.id}: missing components document`);
    }
    const components: NormalizedProviderSnapshot["components"] = {};
    for (const document of currentDocuments) {
      const parsed = componentsDocSchema.safeParse(document.json);
      if (!parsed.success) {
        throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: components document failed schema validation: ${parsed.error.message}`);
      }
      for (const component of parsed.data.components) {
        components[String(component.id)] = {
          state: mapComponentState(component.state, source.id),
          updatedAt: component.updated_at ?? null,
        };
      }
    }

    const incidentDocuments = documentsOfKind(documents, "incidents");
    const listDocuments = incidentDocuments.filter((document) => !isNoticeDetailDocument(document));
    const detailDocuments = incidentDocuments.filter((document) => isNoticeDetailDocument(document));

    const observedUnplannedIds = new Set<number>();
    for (const document of listDocuments) {
      const parsed = noticesListDocSchema.safeParse(document.json);
      if (!parsed.success) {
        throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: notices document failed schema validation: ${parsed.error.message}`);
      }
      for (const notice of parsed.data.notices) {
        if (notice.type === "unplanned") observedUnplannedIds.add(notice.id);
      }
    }

    const incidents: NormalizedProviderSnapshot["incidents"] = [];
    const seenNoticeIds = new Set<number>();
    for (const document of detailDocuments) {
      const parsed = noticeDetailDocSchema.safeParse(document.json);
      if (!parsed.success) {
        throw new AdapterParseError("SCHEMA_INVALID", `${source.id}: notice detail document failed schema validation: ${parsed.error.message}`);
      }
      const { notice } = parsed.data;
      if (notice.type !== "unplanned" || seenNoticeIds.has(notice.id)) continue;
      seenNoticeIds.add(notice.id);
      incidents.push({
        externalId: String(notice.id),
        title: notice.subject,
        state: requireProviderIncidentState(notice.state, source.id),
        impact: null,
        startedAt: requireIsoTimestamp(notice.began_at ?? notice.created_at, source.id, "notice.began_at"),
        resolvedAt: notice.ended_at ? requireIsoTimestamp(notice.ended_at, source.id, "notice.ended_at") : null,
        updatedAt: requireIsoTimestamp(notice.updated_at, source.id, "notice.updated_at"),
        canonicalUrl: notice.url ?? null,
        scope: scopeFromComponentIds(notice.components.map((component) => String(component.id))),
        updates: notice.updates.map((update) => ({
          externalId: String(update.id),
          state: requireProviderIncidentState(update.state, source.id),
          bodyText: toBoundedPlainText(update.content),
          createdAt: requireIsoTimestamp(update.created_at, source.id, "notice_update.created_at"),
          updatedAt: requireIsoTimestamp(update.updated_at, source.id, "notice_update.updated_at"),
        })),
      });
    }

    // Every present or past unplanned notice in a fetched list needs its own detail document, the poller's
    // follow-up request round is expected to have fetched one for each before normalize() runs.
    for (const id of observedUnplannedIds) {
      if (!seenNoticeIds.has(id)) {
        throw new AdapterParseError("MISSING_DOCUMENT", `${source.id}: missing notice detail document for notice ${id}`);
      }
    }

    const providerUpdatedAt = latestTimestamp(incidents.map((incident) => incident.updatedAt));

    return {
      sourceId: source.id,
      observedAt,
      providerUpdatedAt,
      componentsComplete: true,
      // The present unplanned list is followed across every page, so every
      // open notice is enumerated; a notice that ended surfaces via the past
      // list with its ended_at rather than disappearing. The open set is
      // complete.
      incidentsComplete: true,
      components,
      incidents,
      // The unplanned-notice filter deliberately excludes planned maintenance notices;
      // maintenance shows up only as component state, never as a Sorry maintenance entry.
      maintenances: [],
      cache: { etag: null, lastModified: null },
    };
  },
};
