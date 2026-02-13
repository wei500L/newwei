import { describe, expect, it } from "vitest";

import {
  isChineseLanguage,
  resolveDisplayContent,
  resolveDisplaySummary,
  resolveDisplayTitle,
  resolveLanguageLabel
} from "../lib/item-display";

describe("item display helpers", () => {
  it("prefers processed title over item title", () => {
    expect(
      resolveDisplayTitle({
        processedTitle: "LLM Headline",
        itemTitle: "Source: https://example.com/story"
      })
    ).toBe("LLM Headline");
  });

  it("falls back to source when item title looks like a URL", () => {
    expect(
      resolveDisplayTitle({
        itemTitle: "Source: https://example.com/story",
        source: "Source"
      })
    ).toBe("Source");
  });

  it("falls back to hostname when title is URL-like and source missing", () => {
    expect(
      resolveDisplayTitle({
        itemTitle: "https://www.politico.eu/article/world-war-iii-defense-spending-europe-poll",
        originalUrl: "https://www.politico.eu/article/world-war-iii-defense-spending-europe-poll"
      })
    ).toBe("www.politico.eu");
  });

  it("resolves summary with fallback order", () => {
    expect(
      resolveDisplaySummary({
        processedSummary: "Processed summary",
        rawSummary: "Raw summary",
        keyPoints: ["A", "B"]
      })
    ).toBe("Processed summary");

    expect(
      resolveDisplaySummary({
        processedSummary: "",
        rawSummary: "Raw summary",
        keyPoints: ["A", "B"]
      })
    ).toBe("Raw summary");

    expect(
      resolveDisplaySummary({
        processedSummary: "",
        rawSummary: "",
        keyPoints: ["A", "B", "C", "D"]
      })
    ).toBe("A B C");
  });

  it("returns markdown content only when available", () => {
    expect(resolveDisplayContent({ cleanedMarkdown: "## Body" })).toBe("## Body");
    expect(resolveDisplayContent({ cleanedMarkdown: "" })).toBeUndefined();
  });

  it("normalizes language labels and chinese detection", () => {
    expect(resolveLanguageLabel(" zh-CN ")).toBe("zh-CN");
    expect(resolveLanguageLabel(null)).toBeUndefined();
    expect(isChineseLanguage("zh-CN")).toBe(true);
    expect(isChineseLanguage("Chinese")).toBe(true);
    expect(isChineseLanguage("en")).toBe(false);
  });
});
