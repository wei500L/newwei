import { classifySituationMonitorCategory } from "../classification/category-classifier";

describe("situation monitor - category classifier", () => {
  it("prefers explicit category tags", () => {
    expect(
      classifySituationMonitorCategory({
        tags: ["sm:finance", "situation-monitor"],
        result: { category: "ai" },
        rawTags: ["politics"],
        title: "OpenAI announces new model",
        summary: "LLM release",
        source: "example"
      })
    ).toEqual({ category: "finance", source: "tag" });
  });

  it("falls back to result.category", () => {
    expect(
      classifySituationMonitorCategory({
        tags: ["situation-monitor"],
        result: { category: "Financial" },
        rawTags: [],
        title: "Market update",
        summary: null,
        source: null
      })
    ).toEqual({ category: "finance", source: "result-category" });
  });

  it("falls back to result.topics", () => {
    expect(
      classifySituationMonitorCategory({
        tags: [],
        result: { topics: ["LLM", "OpenAI"] },
        rawTags: [],
        title: "New release",
        summary: null,
        source: null
      })
    ).toEqual({ category: "ai", source: "result-topics" });
  });

  it("uses result.category_path with confidence/reason when available", () => {
    expect(
      classifySituationMonitorCategory({
        tags: [],
        result: {
          category_path: "tech/ai/model-release",
          category_confidence: 0.91,
          category_reason: "model launch event"
        },
        rawTags: [],
        title: "New model shipped",
        summary: null,
        source: null
      }),
    ).toEqual(
      expect.objectContaining({
        category: "tech",
        source: "result-category-path",
        confidence: 0.91,
        reason: "model launch event",
      }),
    );
  });

  it("falls back to raw tags when needed", () => {
    expect(
      classifySituationMonitorCategory({
        tags: [],
        result: null,
        rawTags: ["Cyber security", "Defense"],
        title: "Breaking update",
        summary: null,
        source: null
      })
    ).toEqual({ category: "intel", source: "raw-tags" });
  });

  it("uses heuristics as the last resort", () => {
    expect(
      classifySituationMonitorCategory({
        tags: [],
        result: null,
        rawTags: [],
        title: "Nasdaq tumbles after CPI surprise",
        summary: "",
        source: "newswire"
      })
    ).toEqual(
      expect.objectContaining({ category: "finance", source: "heuristic" }),
    );
  });

  it("returns null when no rule matches", () => {
    expect(
      classifySituationMonitorCategory({
        tags: [],
        result: null,
        rawTags: [],
        title: "Random headline",
        summary: "",
        source: ""
      })
    ).toEqual({ category: null, source: null });
  });
});
