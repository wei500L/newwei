import {
  inferNewsContentType,
  NewsContentType,
  normalizeNewsContentType,
} from "../news-content-type";

describe("news-content-type", () => {
  it("normalizes canonical and alias values", () => {
    expect(normalizeNewsContentType("news_fact")).toBe(
      NewsContentType.news_fact,
    );
    expect(normalizeNewsContentType("op-ed")).toBe(NewsContentType.opinion);
    expect(normalizeNewsContentType("分析")).toBe(NewsContentType.analysis);
    expect(normalizeNewsContentType(" mixed-content ")).toBe(
      NewsContentType.mixed,
    );
  });

  it("infers opinion when URL or text is opinion-heavy", () => {
    expect(
      inferNewsContentType({
        title: "Editorial: Why this policy will fail",
        url: "https://example.com/opinion/editorial-policy",
      }),
    ).toBe(NewsContentType.opinion);
  });

  it("infers analysis when explainer/analysis signals dominate", () => {
    expect(
      inferNewsContentType({
        title: "Market analysis: what happens next",
        summary: "Deep dive and explainer on rate path.",
      }),
    ).toBe(NewsContentType.analysis);
  });

  it("infers mixed when both factual and commentary signals are strong", () => {
    expect(
      inferNewsContentType({
        title: "Breaking update with commentary on central bank move",
        summary: "Report and op-ed style reaction from columnists.",
      }),
    ).toBe(NewsContentType.mixed);
  });

  it("defaults to news_fact when no strong opinion/analysis signal exists", () => {
    expect(
      inferNewsContentType({
        title: "Company announces quarterly results",
        summary: "Official statement and filing update.",
      }),
    ).toBe(NewsContentType.news_fact);
  });
});
