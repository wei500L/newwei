import { describe, expect, it } from "vitest";

import { buildHotTopicQueryString } from "@/app/(app)/search/search-hot-topic-query";
import { resolveSuggestionRequestPlan } from "@/components/enhanced-search-box-utils";
import { parseSearchHistory } from "@/lib/search-history";

describe("search suggestion request planning", () => {
  it("invalidates in-flight request sequence when prefix is too short without field context", () => {
    expect(
      resolveSuggestionRequestPlan({
        currentSeq: 3,
        prefix: "a",
        hasFieldContext: false,
      })
    ).toEqual({
      shouldFetch: false,
      nextSeq: 4,
    });
  });

  it("allows empty field prefix requests for guided field suggestions", () => {
    expect(
      resolveSuggestionRequestPlan({
        currentSeq: 7,
        prefix: "",
        hasFieldContext: true,
      })
    ).toEqual({
      shouldFetch: true,
      nextSeq: 7,
    });
  });
});

describe("hot topic query building", () => {
  it("resets layered filters while preserving ranking and pageSize", () => {
    const current = new URLSearchParams(
      "q=old&topic=AI&region=US&sentiment=positive&from=2025-01-01&to=2025-01-31&page=3&mode=headlines&ranking=relevance&pageSize=40&archiveDate=2025-01-15&archiveRegion=APAC&archiveWeights=5,4,3"
    );

    const query = buildHotTopicQueryString(current, "Nvidia");
    const next = new URLSearchParams(query);

    expect(next.get("q")).toBe("Nvidia");
    expect(next.get("mode")).toBe("headlines");
    expect(next.get("ranking")).toBe("relevance");
    expect(next.get("pageSize")).toBe("40");
    expect(next.get("archiveDate")).toBe("2025-01-15");
    expect(next.get("archiveRegion")).toBe("APAC");
    expect(next.get("archiveWeights")).toBe("5,4,3");
    expect(next.has("topic")).toBe(false);
    expect(next.has("region")).toBe(false);
    expect(next.has("sentiment")).toBe(false);
    expect(next.has("from")).toBe(false);
    expect(next.has("to")).toBe(false);
    expect(next.has("page")).toBe(false);
  });

  it("returns empty query when topic is blank", () => {
    const current = new URLSearchParams("ranking=recency&pageSize=20");
    expect(buildHotTopicQueryString(current, "   ")).toBe("");
  });
});

describe("search history parsing", () => {
  it("normalizes history entries and applies limit", () => {
    const raw = JSON.stringify(["  AI  ", "AI", "", "NVIDIA", "  ", "Macro"]);
    expect(parseSearchHistory(raw, 2)).toEqual(["AI", "NVIDIA"]);
  });

  it("returns empty list for invalid payload", () => {
    expect(parseSearchHistory("not-json", 8)).toEqual([]);
  });
});
