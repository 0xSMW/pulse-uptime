import { describe, expect, it } from "vitest";

import { categoryLabel, filterCatalogCategories } from "./add-dependency-sheet";
import type { DependencyCatalogCategory } from "@/lib/dependencies/queries";

const categories: DependencyCatalogCategory[] = [
  {
    category: "ai",
    presets: [
      { id: "openai_api", name: "OpenAI API", provider: "OpenAI", description: "", scope: null, sourceScopeNote: null, fidelity: "component", enabled: true, validated: true, hasValidationError: false, installed: false, installedScopeIds: [] },
      { id: "chatgpt", name: "ChatGPT", provider: "OpenAI", description: "", scope: null, sourceScopeNote: null, fidelity: "component", enabled: true, validated: true, hasValidationError: false, installed: false, installedScopeIds: [] },
    ],
  },
  {
    category: "data",
    presets: [
      { id: "neon_database", name: "Neon Database", provider: "Neon", description: "", scope: { kind: "required_options", options: [{ id: "aws-us-east-1", label: "AWS us-east-1" }] }, sourceScopeNote: null, fidelity: "component", enabled: true, validated: true, hasValidationError: false, installed: false, installedScopeIds: [] },
    ],
  },
];

describe("filterCatalogCategories", () => {
  it("returns every category unchanged for an empty query", () => {
    expect(filterCatalogCategories(categories, "")).toEqual(categories);
    expect(filterCatalogCategories(categories, "   ")).toEqual(categories);
  });

  it("matches by preset name, case-insensitively", () => {
    const result = filterCatalogCategories(categories, "chatgpt");
    expect(result).toHaveLength(1);
    expect(result[0].presets.map((preset) => preset.id)).toEqual(["chatgpt"]);
  });

  it("matches by provider name", () => {
    const result = filterCatalogCategories(categories, "neon");
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("data");
  });

  it("matches across multiple presets within a category", () => {
    const result = filterCatalogCategories(categories, "openai");
    expect(result).toHaveLength(1);
    expect(result[0].presets).toHaveLength(2);
  });

  it("drops categories left with no matching presets", () => {
    const result = filterCatalogCategories(categories, "stripe");
    expect(result).toEqual([]);
  });
});

describe("categoryLabel", () => {
  it("maps known category slugs to their display labels", () => {
    expect(categoryLabel("ai")).toBe("AI");
    expect(categoryLabel("hosting")).toBe("Hosting and network");
    expect(categoryLabel("auth")).toBe("Authentication");
    expect(categoryLabel("data")).toBe("Data");
    expect(categoryLabel("payments")).toBe("Payments and communication");
    expect(categoryLabel("developer")).toBe("Developer infrastructure");
  });

  it("falls back to the raw slug for an unknown category", () => {
    expect(categoryLabel("mystery")).toBe("mystery");
  });
});
