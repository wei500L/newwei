import { CrawlQualityStrategyService } from "../crawl-quality.strategy";

describe("CrawlQualityStrategyService", () => {
  it("prefers fit markdown for quality signal when enabled", () => {
    const service = new CrawlQualityStrategyService({
      extractMarkdownResult: jest.fn().mockReturnValue({
        primary:
          "- [A](https://example.com/a)\n- [B](https://example.com/b)\n- [C](https://example.com/c)\n- [D](https://example.com/d)\n- [E](https://example.com/e)\n- [F](https://example.com/f)\n- [G](https://example.com/g)\n- [H](https://example.com/h)\n- [I](https://example.com/i)\n- [J](https://example.com/j)\n",
        fit:
          "# Headline\n\n" +
          "This is an article paragraph with enough narrative text to look like detail content. ".repeat(
            6,
          ) +
          "\n\nAnother paragraph providing context and details.",
      }),
    } as any);

    const withFit = service.assessArticleMarkdownSignal(
      { url: "https://example.com/story/test" },
      true,
    );
    const withoutFit = service.assessArticleMarkdownSignal(
      { url: "https://example.com/story/test" },
      false,
    );

    expect(withFit.wordCount).toBeGreaterThan(withoutFit.wordCount);
    expect(withFit.isListLike).toBe(false);
  });

  it("keeps short high-value bulletin out of low-signal bucket when publish confidence is high", () => {
    const service = new CrawlQualityStrategyService({
      extractMarkdownResult: jest.fn().mockImplementation((markdown: unknown) => {
        const text = typeof markdown === "string" ? markdown : "";
        return {
          primary: text,
          raw: text,
          fit: text,
        };
      }),
    } as any);

    const bulletin =
      "## Quick Update\n\n" +
      "Markets reacted quickly as policymakers issued a short but material update affecting rates and liquidity. ".repeat(
        3,
      ) +
      "\n\n" +
      "Analysts noted immediate impact while awaiting a full briefing.";

    const page = service.assessPageSignals([
      {
        url: "https://example.com/news/quick-update",
        markdown: bulletin,
        publishedAt: new Date().toISOString(),
        links: { internal: [{ href: "https://example.com/news/full" }] },
      },
    ]);

    expect(page.lowSignalAssessments).toHaveLength(0);
    expect(page.assessments[0]?.quality.publishTimeConfidence).toBeGreaterThan(
      0.75,
    );
  });

  it("resolves detail expansion defaults for new quality controls", () => {
    const service = new CrawlQualityStrategyService({
      extractMarkdownResult: jest.fn().mockReturnValue({ primary: "" }),
    } as any);

    const resolved = service.resolveDetailExpansion({});

    expect(resolved.minPublishTimeConfidence).toBe(0.55);
    expect(resolved.preferFitMarkdownForQuality).toBe(true);
    expect(resolved.excludeUrlPatterns).toEqual(
      expect.arrayContaining(["/tag/", "/archive/", "/latest"]),
    );
  });
});
