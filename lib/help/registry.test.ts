import { describe, expect, it } from "vitest";

import { helpDemos } from "@/components/help/help-demos";
import {
  activeHelpSectionId,
  findHelpEntryId,
  helpEntries,
  helpEntryId,
  helpGroups,
} from "./registry";

const plannedConcepts = [
  "concept-monitors",
  "concept-monitor-states",
  "concept-checks-and-thresholds",
  "concept-uptime-and-unknown",
  "concept-incidents",
  "concept-alerts",
  "concept-status-page",
  "concept-api-tokens-and-agents",
  "concept-database-health",
];

const plannedGuides = [
  "guide-create-monitor",
  "guide-edit-check-settings",
  "guide-test-monitor",
  "guide-pause-monitor",
  "guide-investigate-incident",
  "guide-configure-alerts",
  "guide-test-email",
  "guide-share-status-page",
  "guide-link-pulsectl",
  "guide-connect-agent",
  "guide-database-health",
];

const productRoutes = ["/", "/settings/general", "/settings/monitors", "/settings/access", "/settings/system", "/incidents", "/status", "/docs/cli"];
const genericCopy = ["learn more", "get started", "something went wrong", "click here"];

describe("help registry", () => {
  it("contains every planned anchor exactly once", () => {
    const ids = helpEntries.map(helpEntryId);
    expect(ids).toEqual([...plannedConcepts, ...plannedGuides]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("groups concepts and guides separately", () => {
    expect(helpGroups.map((group) => group.label)).toEqual(["Core Concepts", "How-to Guides"]);
    expect(helpGroups[0]!.entries.every((entry) => entry.kind === "concept")).toBe(true);
    expect(helpGroups[1]!.entries.every((entry) => entry.kind === "guide")).toBe(true);
  });

  it("keeps every summary to one paragraph of at most 70 words", () => {
    for (const entry of helpEntries) {
      expect(entry.summary, entry.slug).not.toContain("\n");
      const words = entry.summary.trim().split(/\s+/).length;
      expect(words, `${helpEntryId(entry)} has ${words} words`).toBeLessThanOrEqual(70);
    }
  });

  it("uses 3–7 steps when steps are present", () => {
    for (const entry of helpEntries) {
      if (!entry.steps) continue;
      expect(entry.steps.length, helpEntryId(entry)).toBeGreaterThanOrEqual(3);
      expect(entry.steps.length, helpEntryId(entry)).toBeLessThanOrEqual(7);
    }
  });

  it("maps every entry to an existing demo", () => {
    for (const entry of helpEntries) {
      expect(helpDemos[entry.demo], `${helpEntryId(entry)} → ${entry.demo}`).toBeDefined();
    }
  });

  it("links only to product routes or existing help anchors", () => {
    const ids = new Set(helpEntries.map(helpEntryId));
    for (const entry of helpEntries) {
      expect(entry.relatedLinks.length, helpEntryId(entry)).toBeGreaterThan(0);
      for (const link of entry.relatedLinks) {
        if (link.href.startsWith("#")) {
          expect(ids.has(link.href.slice(1)), `${helpEntryId(entry)} → ${link.href}`).toBe(true);
        } else {
          expect(productRoutes, `${helpEntryId(entry)} → ${link.href}`).toContain(link.href);
        }
      }
    }
  });

  it("avoids generic copy in titles, summaries, and link labels", () => {
    for (const entry of helpEntries) {
      const text = [entry.title, entry.summary, ...entry.relatedLinks.map((link) => link.label)]
        .join(" ")
        .toLowerCase();
      for (const phrase of genericCopy) {
        expect(text, `${helpEntryId(entry)} contains "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it("keeps fixtures free of production hosts and secrets", () => {
    const text = JSON.stringify(helpEntries).toLowerCase();
    expect(text).not.toMatch(/pulse_live_[a-z0-9]/);
    expect(text).not.toContain("vercel.app");
    expect(text).not.toContain("productos");
  });
});

describe("findHelpEntryId", () => {
  it("resolves known anchors with or without the hash", () => {
    expect(findHelpEntryId("#concept-monitors")).toBe("concept-monitors");
    expect(findHelpEntryId("guide-create-monitor")).toBe("guide-create-monitor");
  });

  it("returns null for unknown anchors", () => {
    expect(findHelpEntryId("#concept-billing")).toBeNull();
    expect(findHelpEntryId("")).toBeNull();
  });
});

describe("activeHelpSectionId", () => {
  const positions = [
    { id: "a", top: 0 },
    { id: "b", top: 400 },
    { id: "c", top: 900 },
  ];

  it("returns the section above the reading line", () => {
    expect(activeHelpSectionId(positions, 0, 120)).toBe("a");
    expect(activeHelpSectionId(positions, 300, 120)).toBe("b");
    expect(activeHelpSectionId(positions, 900, 120)).toBe("c");
  });

  it("falls back to the first section before any threshold", () => {
    expect(activeHelpSectionId(positions, 0, 0)).toBe("a");
    expect(activeHelpSectionId([], 100, 120)).toBeNull();
  });
});
