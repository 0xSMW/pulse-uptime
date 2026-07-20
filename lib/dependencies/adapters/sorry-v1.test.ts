import { describe, expect, it } from "vitest";

import { loadCatalogManifest } from "../manifest";

import componentsDegraded from "./fixtures/postmark/components-degraded.json";
import componentsMaintenance from "./fixtures/postmark/components-maintenance.json";
import componentsMissingComponent from "./fixtures/postmark/components-missing-component.json";
import componentsOperational from "./fixtures/postmark/components-operational.json";
import componentsPage1 from "./fixtures/postmark/components-page1.json";
import componentsPage2 from "./fixtures/postmark/components-page2.json";
import malformedComponents from "./fixtures/postmark/malformed-components.json";
import noticeDetail503440 from "./fixtures/postmark/notice-detail-503440.json";
import noticeDetail503441 from "./fixtures/postmark/notice-detail-503441.json";
import noticeDetail503442Active from "./fixtures/postmark/notice-detail-503442-active.json";
import noticeDetail503442Ended from "./fixtures/postmark/notice-detail-503442-ended.json";
import noticesEmpty from "./fixtures/postmark/notices-empty.json";
import noticesListOne from "./fixtures/postmark/notices-list-one.json";
import noticesListPastOne from "./fixtures/postmark/notices-list-past-one.json";
import noticesListPastPage1 from "./fixtures/postmark/notices-list-past-page1.json";
import noticesListPastPage2 from "./fixtures/postmark/notices-list-past-page2.json";
import noticesListPastPage3 from "./fixtures/postmark/notices-list-past-page3.json";
import noticesListPresent503442 from "./fixtures/postmark/notices-list-present-503442.json";
import noticesPage1 from "./fixtures/postmark/notices-page1.json";
import noticesPage2 from "./fixtures/postmark/notices-page2.json";
import type { AdapterDocument } from "./index";
import { AdapterParseError } from "./shared";
import { sorryV1Adapter } from "./sorry-v1";

const manifest = loadCatalogManifest();
const postmarkSource = manifest.sources.find((source) => source.id === "postmark")!;
const emailDeliveryPreset = manifest.presets.find((preset) => preset.id === "postmark_email_delivery")!;

const componentsUrl = postmarkSource.config.componentsUrl as string;
const noticesBaseUrl = postmarkSource.incidentsUrl!;
const notice503440Url = (postmarkSource.config.noticeDetailUrlTemplate as string).replace("{id}", "503440");
const notice503441Url = (postmarkSource.config.noticeDetailUrlTemplate as string).replace("{id}", "503441");
const notice503442Url = (postmarkSource.config.noticeDetailUrlTemplate as string).replace("{id}", "503442");

function doc(kind: AdapterDocument["kind"], url: string, json: unknown): AdapterDocument {
  return { kind, url, json };
}

describe("sorryV1Adapter.requests: first round", () => {
  it("asks for the components page, the present-unplanned notices list, and the past-unplanned notices list, with the filter query params applied", () => {
    const requests = sorryV1Adapter.requests(postmarkSource);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({ kind: "current", url: componentsUrl, optional: false });
    const presentRequest = requests[1];
    expect(presentRequest.kind).toBe("incidents");
    expect(presentRequest.url).toContain("filter%5Btimeline_state_eq%5D=present");
    expect(presentRequest.url).toContain("filter%5Btype_eq%5D=unplanned");
    const pastRequest = requests[2];
    expect(pastRequest.kind).toBe("incidents");
    expect(pastRequest.url).toContain("filter%5Btimeline_state_eq%5D=past");
    expect(pastRequest.url).toContain("filter%5Btype_eq%5D=unplanned");
  });
});

describe("sorryV1Adapter.requests: pagination follow-up", () => {
  it("asks for the next components page when meta.next_page is present", () => {
    const fetchedSoFar: AdapterDocument[] = [
      doc("current", componentsUrl, componentsPage1),
      doc("incidents", `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=present&filter%5Btype_eq%5D=unplanned`, noticesEmpty),
    ];
    const requests = sorryV1Adapter.requests(postmarkSource, fetchedSoFar);
    expect(requests).toEqual([{ kind: "current", url: new URL("/api/v1/components?page=2", componentsUrl).toString(), optional: false }]);
  });

  it("asks for a notice detail document for every present unplanned notice in the list", () => {
    const listUrl = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=present&filter%5Btype_eq%5D=unplanned`;
    const fetchedSoFar: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", listUrl, noticesListOne),
    ];
    const requests = sorryV1Adapter.requests(postmarkSource, fetchedSoFar);
    expect(requests).toEqual([{ kind: "incidents", url: notice503440Url, optional: false }]);
  });

  it("follows a paginated notices list across pages, requesting each page's own notice detail", () => {
    const listPage1Url = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=present&filter%5Btype_eq%5D=unplanned`;
    const afterPage1: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", listPage1Url, noticesPage1),
    ];
    const afterPage1Requests = sorryV1Adapter.requests(postmarkSource, afterPage1);
    const page2Url = new URL("/api/v1/notices?page=2", noticesBaseUrl).toString();
    expect(afterPage1Requests).toEqual(
      expect.arrayContaining([{ kind: "incidents", url: page2Url, optional: false }, { kind: "incidents", url: notice503440Url, optional: false }]),
    );

    const afterPage2: AdapterDocument[] = [...afterPage1, doc("incidents", page2Url, noticesPage2), doc("incidents", notice503440Url, noticeDetail503440)];
    const afterPage2Requests = sorryV1Adapter.requests(postmarkSource, afterPage2);
    expect(afterPage2Requests).toEqual([{ kind: "incidents", url: notice503441Url, optional: false }]);
  });

  it("requests nothing further once every page and every notice detail has been fetched", () => {
    const listUrl = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=present&filter%5Btype_eq%5D=unplanned`;
    const fetchedSoFar: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", listUrl, noticesListOne),
      doc("incidents", notice503440Url, noticeDetail503440),
    ];
    expect(sorryV1Adapter.requests(postmarkSource, fetchedSoFar)).toEqual([]);
  });

  it("asks for a notice detail document for a notice found in the past-unplanned list, same as a present one", () => {
    const pastListUrl = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned`;
    const fetchedSoFar: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", pastListUrl, noticesListPastOne),
    ];
    const requests = sorryV1Adapter.requests(postmarkSource, fetchedSoFar);
    expect(requests).toEqual([{ kind: "incidents", url: notice503442Url, optional: false }]);
  });

  it("follows the past-unplanned list beyond its first page so a notice that resolved onto a deeper past page is still reached", () => {
    const pastPage1Url = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned`;
    const pastPage2Url = new URL("/api/v1/notices?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned&page=2", noticesBaseUrl).toString();

    const afterPage1: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", pastPage1Url, noticesListPastPage1),
    ];
    const afterPage1Requests = sorryV1Adapter.requests(postmarkSource, afterPage1);
    expect(afterPage1Requests).toEqual(
      expect.arrayContaining([
        { kind: "incidents", url: pastPage2Url, optional: false },
        { kind: "incidents", url: notice503440Url, optional: false },
      ]),
    );

    // Notice 503442 resolved and now sits on past page 2, its detail is requested only because
    // pagination followed the past list past its first page.
    const afterPage2: AdapterDocument[] = [
      ...afterPage1,
      doc("incidents", notice503440Url, noticeDetail503440),
      doc("incidents", pastPage2Url, noticesListPastPage2),
    ];
    const afterPage2Requests = sorryV1Adapter.requests(postmarkSource, afterPage2);
    const pastPage3Url = new URL("/api/v1/notices?page=3", noticesBaseUrl).toString();
    expect(afterPage2Requests).toEqual(
      expect.arrayContaining([
        { kind: "incidents", url: pastPage3Url, optional: false },
        { kind: "incidents", url: notice503442Url, optional: false },
      ]),
    );
  });

  it("stops following the past-unplanned list at the bounded page cap, it does not walk deeper history", () => {
    const pastPage1Url = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned`;
    const pastPage2Url = new URL("/api/v1/notices?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned&page=2", noticesBaseUrl).toString();
    const pastPage3Url = new URL("/api/v1/notices?page=3", noticesBaseUrl).toString();
    const pastPage4Url = new URL("/api/v1/notices?page=4", noticesBaseUrl).toString();

    // Three past pages fetched, chained even though page 2's next_page link drops the timeline filter.
    const afterPage3: AdapterDocument[] = [
      doc("current", componentsUrl, componentsOperational),
      doc("incidents", pastPage1Url, noticesListPastPage1),
      doc("incidents", pastPage2Url, noticesListPastPage2),
      doc("incidents", pastPage3Url, noticesListPastPage3),
      doc("incidents", notice503440Url, noticeDetail503440),
      doc("incidents", notice503442Url, noticeDetail503442Ended),
    ];
    const afterPage3Requests = sorryV1Adapter.requests(postmarkSource, afterPage3);
    // The one remaining request is page 3's own notice detail, never a fourth past page.
    expect(afterPage3Requests).toEqual([{ kind: "incidents", url: notice503441Url, optional: false }]);
    expect(afterPage3Requests.some((request) => request.url === pastPage4Url)).toBe(false);

    const afterAll: AdapterDocument[] = [...afterPage3, doc("incidents", notice503441Url, noticeDetail503441)];
    expect(sorryV1Adapter.requests(postmarkSource, afterAll)).toEqual([]);
  });
});

describe("sorryV1Adapter.normalize: pagination handling", () => {
  it("merges components across multiple fetched pages", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsPage1), doc("current", `${componentsUrl}?page=2`, componentsPage2), doc("incidents", noticesBaseUrl, noticesEmpty)],
      observedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(Object.keys(snapshot.components)).toHaveLength(19);
    expect(snapshot.components["87154"]).toMatchObject({ state: "OPERATIONAL" });
    expect(snapshot.components["87151"]).toMatchObject({ state: "OPERATIONAL" });
  });
});

describe("sorryV1Adapter.normalize: component selection against the catalog", () => {
  it("selects the postmark_email_delivery preset's components by their real numeric ids", () => {
    expect(emailDeliveryPreset.selector).toMatchObject({ kind: "component_ids", ids: ["87154", "87151"] });
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsDegraded), doc("incidents", noticesBaseUrl, noticesEmpty)],
      observedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(snapshot.components["87154"]).toMatchObject({ state: "DEGRADED" });
    expect(snapshot.components["87151"]).toMatchObject({ state: "OPERATIONAL" });
  });
});

describe("sorryV1Adapter.normalize: component status mapping", () => {
  it("maps operational, degraded, and under_maintenance", () => {
    const empty = doc("incidents", noticesBaseUrl, noticesEmpty);
    expect(sorryV1Adapter.normalize({ source: postmarkSource, documents: [doc("current", componentsUrl, componentsOperational), empty], observedAt: "2026-07-19T12:00:00.000Z" }).components["87154"].state).toBe("OPERATIONAL");
    expect(sorryV1Adapter.normalize({ source: postmarkSource, documents: [doc("current", componentsUrl, componentsDegraded), empty], observedAt: "2026-07-19T12:00:00.000Z" }).components["87154"].state).toBe("DEGRADED");
    expect(sorryV1Adapter.normalize({ source: postmarkSource, documents: [doc("current", componentsUrl, componentsMaintenance), empty], observedAt: "2026-07-19T12:00:00.000Z" }).components["87151"].state).toBe("MAINTENANCE");
  });
});

describe("sorryV1Adapter.normalize: notices", () => {
  it("builds a full incident from the notice list plus its detail document, with impacted components and updates", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesListOne), doc("incidents", notice503440Url, noticeDetail503440)],
      observedAt: "2026-07-07T02:00:00.000Z",
    });
    expect(snapshot.incidents).toHaveLength(1);
    const [incident] = snapshot.incidents;
    expect(incident.externalId).toBe("503440");
    expect(incident.state).toBe("resolved");
    expect(incident.componentIds).toEqual(["93625"]);
    expect(incident.updates.map((update) => update.state)).toEqual(["investigating", "investigating", "recovering", "resolved"]);
  });

  it("strips HTML from update content", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesListOne), doc("incidents", notice503440Url, noticeDetail503440)],
      observedAt: "2026-07-07T02:00:00.000Z",
    });
    const firstUpdate = snapshot.incidents[0].updates[0];
    expect(firstUpdate.bodyText).toBe("We are investigating an issue causing inbound webhook delays.");
  });

  it("maps recovering as an active-recovery state and resolved as terminal", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesListOne), doc("incidents", notice503440Url, noticeDetail503440)],
      observedAt: "2026-07-07T02:00:00.000Z",
    });
    const states = snapshot.incidents[0].updates.map((update) => update.state);
    expect(states).toContain("recovering");
    expect(states.at(-1)).toBe("resolved");
  });

  it("normalizing the same documents twice yields identical incident and update external ids", () => {
    const documents = [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesListOne), doc("incidents", notice503440Url, noticeDetail503440)];
    const first = sorryV1Adapter.normalize({ source: postmarkSource, documents, observedAt: "2026-07-07T02:00:00.000Z" });
    const second = sorryV1Adapter.normalize({ source: postmarkSource, documents, observedAt: "2026-07-07T02:05:00.000Z" });
    expect(first.incidents.map((incident) => incident.externalId)).toEqual(second.incidents.map((incident) => incident.externalId));
    expect(first.incidents[0].updates.map((update) => update.externalId)).toEqual(second.incidents[0].updates.map((update) => update.externalId));
  });

  it("assembles incidents across a paginated notice list, each with its own detail document", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [
        doc("current", componentsUrl, componentsOperational),
        doc("incidents", noticesBaseUrl, noticesPage1),
        doc("incidents", new URL("/api/v1/notices?page=2", noticesBaseUrl).toString(), noticesPage2),
        doc("incidents", notice503440Url, noticeDetail503440),
        doc("incidents", notice503441Url, noticeDetail503441),
      ],
      observedAt: "2026-07-19T11:00:00.000Z",
    });
    expect(snapshot.incidents.map((incident) => incident.externalId).sort()).toEqual(["503440", "503441"]);
  });

  it("never populates maintenances, the unplanned-notice filter excludes planned maintenance notices", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesEmpty)],
      observedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(snapshot.maintenances).toEqual([]);
  });
});

describe("sorryV1Adapter.normalize: a notice that ends between polls", () => {
  it("reports resolvedAt null while the notice is present, then non-null once it has moved to the past list", () => {
    const pollOneSnapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [
        doc("current", componentsUrl, componentsOperational),
        doc("incidents", noticesBaseUrl, noticesListPresent503442),
        doc("incidents", notice503442Url, noticeDetail503442Active),
      ],
      observedAt: "2026-07-18T09:15:00.000Z",
    });
    expect(pollOneSnapshot.incidents).toHaveLength(1);
    expect(pollOneSnapshot.incidents[0].externalId).toBe("503442");
    expect(pollOneSnapshot.incidents[0].resolvedAt).toBeNull();

    // The notice ended and left the present list entirely between polls, the past list is where its
    // ended_at is now observed.
    const pollTwoSnapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [
        doc("current", componentsUrl, componentsOperational),
        doc("incidents", noticesBaseUrl, noticesEmpty),
        doc("incidents", `${noticesBaseUrl}?past`, noticesListPastOne),
        doc("incidents", notice503442Url, noticeDetail503442Ended),
      ],
      observedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(pollTwoSnapshot.incidents).toHaveLength(1);
    expect(pollTwoSnapshot.incidents[0].externalId).toBe("503442");
    expect(pollTwoSnapshot.incidents[0].state).toBe("resolved");
    expect(pollTwoSnapshot.incidents[0].resolvedAt).toBe("2026-07-18T11:45:00.000Z");
  });

  it("observes a resolution that landed on the second past page, not just the first", () => {
    const pastPage1Url = `${noticesBaseUrl}?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned`;
    const pastPage2Url = new URL("/api/v1/notices?filter%5Btimeline_state_eq%5D=past&filter%5Btype_eq%5D=unplanned&page=2", noticesBaseUrl).toString();

    // 503442 ended and moved onto past page 2, its ended_at is only reachable because pagination
    // followed the past list past its first page.
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [
        doc("current", componentsUrl, componentsOperational),
        doc("incidents", noticesBaseUrl, noticesEmpty),
        doc("incidents", pastPage1Url, noticesListPastPage1),
        doc("incidents", pastPage2Url, noticesListPastPage2),
        doc("incidents", notice503440Url, noticeDetail503440),
        doc("incidents", notice503442Url, noticeDetail503442Ended),
      ],
      observedAt: "2026-07-18T12:00:00.000Z",
    });
    const resolved = snapshot.incidents.find((incident) => incident.externalId === "503442");
    expect(resolved).toBeDefined();
    expect(resolved!.state).toBe("resolved");
    expect(resolved!.resolvedAt).toBe("2026-07-18T11:45:00.000Z");
  });
});

describe("sorryV1Adapter.normalize: failure handling", () => {
  it("throws AdapterParseError on an unrecognized top-level shape", () => {
    expect(() =>
      sorryV1Adapter.normalize({ source: postmarkSource, documents: [doc("current", componentsUrl, malformedComponents), doc("incidents", noticesBaseUrl, noticesEmpty)], observedAt: "2026-07-19T12:00:00.000Z" }),
    ).toThrow(AdapterParseError);
  });

  it("throws MISSING_DOCUMENT when a present unplanned notice has no detail document fetched", () => {
    try {
      sorryV1Adapter.normalize({
        source: postmarkSource,
        documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesListOne)],
        observedAt: "2026-07-19T12:00:00.000Z",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError);
      expect((error as AdapterParseError).code).toBe("MISSING_DOCUMENT");
    }
  });

  it("throws MISSING_DOCUMENT when a past unplanned notice has no detail document fetched", () => {
    try {
      sorryV1Adapter.normalize({
        source: postmarkSource,
        documents: [doc("current", componentsUrl, componentsOperational), doc("incidents", noticesBaseUrl, noticesEmpty), doc("incidents", `${noticesBaseUrl}?past`, noticesListPastOne)],
        observedAt: "2026-07-19T12:00:00.000Z",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterParseError);
      expect((error as AdapterParseError).code).toBe("MISSING_DOCUMENT");
    }
  });

  it("does not throw when a catalog component id has been removed from the feed", () => {
    const snapshot = sorryV1Adapter.normalize({
      source: postmarkSource,
      documents: [doc("current", componentsUrl, componentsMissingComponent), doc("incidents", noticesBaseUrl, noticesEmpty)],
      observedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(snapshot.components["87154"]).toBeUndefined();
    expect(snapshot.components["87151"]).toBeUndefined();
    // componentsComplete true (FIX B): a successful components document
    // enumerates every component, so this absence resolves to UNKNOWN.
    expect(snapshot.componentsComplete).toBe(true);
  });
});
