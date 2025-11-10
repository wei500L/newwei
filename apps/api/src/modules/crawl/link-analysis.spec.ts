import { buildLinkAnalysis } from "./link-analysis";

describe("buildLinkAnalysis", () => {
  it("computes stats and rankings for normalized links", () => {
    const analysis = buildLinkAnalysis({
      internal: [
        { href: "https://example.com/a", text: "Guide", intrinsic_score: 8.4, total_score: 0.92 },
        { href: "https://example.com/b", text: "Policy", intrinsic_score: 2.2 }
      ],
      external: [
        { href: "https://news.example.com/story", text: "Story", intrinsicScore: 4.2, contextual_score: 0.81 }
      ]
    });

    expect(analysis).toBeDefined();
    expect(analysis?.stats.totalLinks).toBe(3);
    expect(analysis?.stats.internalLinks).toBe(2);
    expect(analysis?.stats.externalLinks).toBe(1);
    expect(analysis?.stats.highQualityLinks).toBe(1);
    expect(analysis?.stats.lowQualityLinks).toBe(1);
    expect(analysis?.topLinks[0].href).toBe("https://example.com/a");
    expect(analysis?.lowQualityLinks[0].href).toBe("https://example.com/b");
    expect(analysis?.buckets.length).toBe(2);
  });

  it("returns undefined when no valid links exist", () => {
    expect(buildLinkAnalysis(undefined)).toBeUndefined();
    expect(buildLinkAnalysis({ internal: [{ href: "" }] })).toBeUndefined();
  });
});
