import { buildNewsSignalFromProcessedArticle, NewsSentimentLabel } from "./news-signal";

describe("buildNewsSignalFromProcessedArticle", () => {
  it("clamps future publishedAt to now", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
    try {
      const signal = buildNewsSignalFromProcessedArticle({
        processedArticle: {
          id: "pa-1",
          articleId: "a-1",
          processedAt: new Date("2026-02-10T00:00:00.000Z"),
          publishedAt: new Date("2026-08-05T00:00:00.000Z"),
          language: "en",
          title: "Title",
          summary: "Summary",
          topics: [],
          entities: [],
          qualityScore: 0.8,
          cleanedMarkdownRef: "507f1f77bcf86cd799439011"
        },
        article: { crawlAt: new Date("2026-02-11T00:00:00.000Z") }
      });

      expect(signal.timestamp.toISOString()).toBe("2026-02-15T12:00:00.000Z");
    } finally {
      jest.useRealTimers();
    }
  });

  it("prefers publishedAt over crawlAt and processedAt", () => {
    const signal = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-03T00:00:00.000Z"),
        language: "en",
        title: "Title",
        summary: "Summary",
        topics: [],
        entities: [],
        qualityScore: 0.8,
        cleanedMarkdownRef: "507f1f77bcf86cd799439011"
      },
      article: { crawlAt: new Date("2026-01-02T00:00:00.000Z") }
    });

    expect(signal.timestamp.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("falls back to crawlAt then processedAt", () => {
    const fromCrawl = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-03T00:00:00.000Z"),
        publishedAt: null,
        language: null,
        title: null,
        summary: null,
        topics: [],
        entities: [],
        qualityScore: null,
        cleanedMarkdownRef: null
      },
      article: { crawlAt: new Date("2026-01-02T00:00:00.000Z") }
    });
    expect(fromCrawl.timestamp.toISOString()).toBe("2026-01-02T00:00:00.000Z");

    const fromProcessed = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-03T00:00:00.000Z"),
        publishedAt: null,
        language: null,
        title: null,
        summary: null,
        topics: [],
        entities: [],
        qualityScore: null,
        cleanedMarkdownRef: null
      },
      article: { crawlAt: null }
    });
    expect(fromProcessed.timestamp.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("normalizes topics and entities", () => {
    const signal = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: null,
        language: null,
        title: "  ",
        summary: null,
        topics: [" topic-1 ", "topic-1", { name: "topic-2" }, { topic: "topic-3" }, 123],
        entities: [
          { name: "Entity A", type: "org", confidence: 0.8 },
          { name: "Entity B", confidence: 2 },
          { name: "  ", type: "org", confidence: 0.5 },
          "Entity C",
          null
        ],
        qualityScore: 1.2,
        cleanedMarkdownRef: "pi-1"
      },
      article: { crawlAt: null }
    });

    expect(signal.topics).toEqual(["topic-1", "topic-2", "topic-3"]);
    expect(signal.entities).toEqual(
      expect.arrayContaining([
        { name: "Entity A", type: "org", confidence: 0.8 },
        { name: "Entity B", type: null, confidence: 1 },
        { name: "Entity C", type: null, confidence: null }
      ])
    );
    expect(signal.title).toBeNull();
    expect(signal.qualityScore).toBe(1);
  });

  it("extracts sentiment from processed item result", () => {
    const signal = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: null,
        language: null,
        title: null,
        summary: null,
        topics: [],
        entities: [],
        qualityScore: null,
        cleanedMarkdownRef: null
      },
      article: { crawlAt: null },
      processedItemResult: { sentiment_label: "POS" }
    });
    expect(signal.sentiment).toBe(NewsSentimentLabel.Positive);
  });

  it("falls back language to article when processed language is missing", () => {
    const signal = buildNewsSignalFromProcessedArticle({
      processedArticle: {
        id: "pa-1",
        articleId: "a-1",
        processedAt: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: null,
        language: null,
        title: null,
        summary: null,
        topics: [],
        entities: [],
        qualityScore: null,
        cleanedMarkdownRef: null
      },
      article: { crawlAt: null, language: "zh" }
    });
    expect(signal.language).toBe("zh");
  });
});
