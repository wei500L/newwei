import { CrawlResultService } from "../crawl-result.service";

describe("CrawlResultService", () => {
  const createService = (
    maxBytes: number,
    overrides?: {
      prisma?: any;
      moduleRef?: any;
    }
  ) =>
    new CrawlResultService(
      (overrides?.prisma ?? {}) as any,
      {
        crawl4aiConfig: {
          media: { fetchTimeoutMs: 1000, maxBytes, maxPerResult: 10 }
        }
      } as any,
      {} as any,
      (overrides?.moduleRef ?? { get: jest.fn() }) as any
    );

  it("skips inline assets when the Data URI is too long", () => {
    const service = createService(8);
    const bufferFromSpy = jest.spyOn(Buffer, "from");
    const dataUri = `data:image/png;base64,${"A".repeat(5000)}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toBeUndefined();
    expect(bufferFromSpy).not.toHaveBeenCalled();
    bufferFromSpy.mockRestore();
  });

  it("skips inline assets when the decoded bytes exceed maxBytes", () => {
    const service = createService(4);
    const bufferFromSpy = jest.spyOn(Buffer, "from");
    const payload = Buffer.alloc(5).toString("base64");
    const dataUri = `data:image/png;base64,${payload}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toBeUndefined();
    expect(bufferFromSpy).not.toHaveBeenCalled();
    bufferFromSpy.mockRestore();
  });

  it("builds an asset for small inline base64 media", () => {
    const service = createService(128);
    const payload = Buffer.from("hello").toString("base64");
    const dataUri = `data:image/png;base64,${payload}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toEqual(
      expect.objectContaining({
        kind: "image",
        bytes: 5,
        contentType: "image/png",
        sourceUrl: "data-uri:inline",
        data: Buffer.from("hello")
      })
    );
  });

  it("ignores non-base64 data URIs", () => {
    const service = createService(128);

    const asset = (service as any).buildInlineMediaAsset("data:image/png,hello", "image", {});

    expect(asset).toBeUndefined();
  });

  it("prefers richer markdown variant for primary content", () => {
    const service = createService(128);

    const result = service.extractMarkdownResult({
      fit_markdown: "# Short",
      raw_markdown: "# Menu\n- Home\n- World\n- Markets",
      markdown_with_citations:
        "# Headline[^1]\n\nThis is a full article body with multiple sentences and context.\n\nAnother paragraph with additional details.[^2]",
      references_markdown: "[^1]: https://example.com/a\n[^2]: https://example.com/b"
    });

    expect(result.primary).toBe(result.citations);
    expect((result.primary ?? "").length).toBeGreaterThan((result.fit ?? "").length);
  });

  it("removes citation reference list from primary markdown body", () => {
    const service = createService(128);

    const result = service.extractMarkdownResult({
      markdown_with_citations:
        "# Headline[^1]\n\nBody paragraph with context and details.[^2]\n\n[^1]: https://example.com/a\n[^2]: https://example.com/b",
      references_markdown: "[^1]: https://example.com/a\n[^2]: https://example.com/b"
    });

    expect(result.primary).toContain("Body paragraph with context and details.");
    expect(result.primary).not.toContain("[^1]: https://example.com/a");
    expect(result.citations).toContain("[^1]: https://example.com/a");
  });

  it("does not let references-heavy citations force a short fit markdown", () => {
    const service = createService(128);

    const result = service.extractMarkdownResult({
      fit_markdown: "# Digest\n- one\n- two",
      markdown_with_citations:
        "# Reuters World[^1]\n\nDetailed paragraph one with meaningful context and numbers.\n\nDetailed paragraph two with more context and quotes.[^2]\n\n[^1]: https://example.com/a\n[^2]: https://example.com/b\n[^3]: https://example.com/c\n[^4]: https://example.com/d",
      raw_markdown:
        "# Reuters World\n\nDetailed paragraph one with meaningful context and numbers.\n\nDetailed paragraph two with more context and quotes."
    });

    expect(result.primary).not.toBe(result.fit);
    expect((result.primary ?? "").length).toBeGreaterThan((result.fit ?? "").length);
  });

  it("prefers richer raw markdown when fit markdown is too short", () => {
    const service = createService(128);

    const longBody = "Paragraph with detailed article context about diplomacy, markets, and policy changes.\n".repeat(90);

    const result = service.extractMarkdownResult({
      fit_markdown: "# Digest\n- bullet one\n- bullet two",
      raw_markdown: `# Full Article\n\n${longBody}`
    });

    expect(result.primary).toBe(result.raw);
    expect((result.primary ?? "").length).toBeGreaterThan(2000);
    expect((result.fit ?? "").length).toBeLessThan(80);
  });

  it("detects and deprioritizes anti-bot challenge markdown", () => {
    const service = createService(128);

    expect(
      service.isLikelyBotChallengeMarkdown("Verification Required\nPlease enable JS and disable any ad blocker")
    ).toBe(true);

    const result = service.extractMarkdownResult({
      markdown_with_citations: "Verification Required\nPlease enable JS and disable any ad blocker",
      raw_markdown:
        "# Legitimate content\n\nThis paragraph contains actual article context and should win over challenge text."
    });

    expect(result.primary).toContain("Legitimate content");
  });

  it("flags references-only markdown as low-signal", () => {
    const service = createService(128);

    expect(service.isLowSignalMarkdown("## References")).toBe(true);
    expect(
      service.isLowSignalMarkdown(
        "## References\n\n[^1]: https://example.com/a\n[^2]: https://example.com/b"
      )
    ).toBe(true);
  });

  it("does not flag normal article markdown as low-signal", () => {
    const service = createService(128);

    const markdown =
      "# Headline\n\n" +
      "This is the first article paragraph with context and implications.\n\n" +
      "This is the second paragraph with additional reporting details and quotes.";

    expect(service.isLowSignalMarkdown(markdown)).toBe(false);
  });

  it("normalizes markdown text for RAG-friendly structure", () => {
    const service = createService(128);

    const raw =
      "# Title\r\n\r\nParagraph one.   \r\n\r\n\r\n\u200BMenu\nMenu\nMenu\n\nParagraph two.\r\n";

    const result = service.extractMarkdownResult(raw);

    expect(result.primary).toBe("# Title\n\nParagraph one.\n\nMenu\nMenu\n\nParagraph two.");
  });

  it("removes common ad and subscription noise while preserving article body", () => {
    const service = createService(128);

    const raw =
      "Advertisement\n" +
      "# Headline\n\n" +
      "Free article usually reserved for subscribers\n" +
      "Listen\n" +
      "AI generated Text-to-speech\n" +
      "\n" +
      "Paragraph one with policy context and details.\n\n" +
      "Advertisement\n" +
      "Paragraph two with background and quotes.";

    const result = service.extractMarkdownResult(raw);

    expect(result.primary).toContain("# Headline");
    expect(result.primary).toContain("Paragraph one with policy context and details.");
    expect(result.primary).toContain("Paragraph two with background and quotes.");
    expect(result.primary).not.toContain("Advertisement");
    expect(result.primary).not.toContain("Free article usually reserved for subscribers");
    expect(result.primary).not.toContain("AI generated Text-to-speech");
  });

  it("drops navigation-heavy preamble before headline", () => {
    const service = createService(128);

    const raw =
      "[Skip to main content](https://example.com/#main)\n" +
      "[ ](https://example.com)\n" +
      "Menu\n" +
      "[ POLITICO Pro ](https://example.com/pro/)\n" +
      "[ Log In ](https://example.com/login/)\n" +
      "# Headline\n\n" +
      "Paragraph one with article context.\n\n" +
      "Paragraph two with background.";

    const result = service.extractMarkdownResult(raw);

    expect(result.primary).toContain("# Headline");
    expect(result.primary).toContain("Paragraph one with article context.");
    expect(result.primary).toContain("Paragraph two with background.");
    expect(result.primary).not.toContain("Skip to main content");
    expect(result.primary).not.toContain("POLITICO Pro");
    expect(result.primary).not.toContain("Log In");
  });

  it("keeps content when aggressive noise filtering would over-truncate", () => {
    const service = createService(128);

    const raw =
      "Advertisement\n" +
      "Subscribe\n" +
      "Cookie policy\n" +
      "Terms of Service\n" +
      "Quick update on markets.";

    const result = service.extractMarkdownResult(raw);

    expect(result.primary).toContain("Quick update on markets.");
  });

  it("continues crawl flow when media persistence fails", async () => {
    const mediaService = {
      storeAsset: jest.fn().mockRejectedValue(new Error("S3 unavailable"))
    };
    const moduleRef = {
      get: jest.fn().mockReturnValue(mediaService)
    };
    const service = createService(1024, { moduleRef });
    const task = {
      id: "task-1",
      orgId: "org-1",
      targetUrl: "https://example.com"
    } as any;
    const mediaDataUri = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`;
    const media = {
      images: [{ src: mediaDataUri }]
    } as any;

    await expect(
      (service as any).collectMediaAssets(task, "result-1", media)
    ).resolves.toBeUndefined();

    expect(mediaService.storeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        taskId: "task-1",
        resultId: "result-1"
      })
    );
    expect(mediaService.storeAsset).toHaveBeenCalledTimes(1);
    expect(moduleRef.get).toHaveBeenCalledWith(expect.any(Function), {
      strict: false
    });
  });

  it("selects the earliest created row as org dedupe winner", () => {
    const service = createService(128);
    const created = {
      id: "result-new",
      fetchedAt: new Date("2026-02-26T10:05:00.000Z"),
      createdAt: new Date("2026-02-26T10:05:00.000Z"),
    };
    const existing = [
      {
        id: "result-existing",
        fetchedAt: new Date("2026-02-26T10:00:00.000Z"),
        createdAt: new Date("2026-02-26T10:00:00.000Z"),
      },
    ];

    const winner = (service as any).selectOrgDedupeWinner(created, existing);

    expect(winner).toEqual({
      id: "result-existing",
      fetchedAt: new Date("2026-02-26T10:00:00.000Z"),
    });
  });

  it("uses id as a stable tie-breaker for org dedupe winner selection", () => {
    const service = createService(128);
    const createdAt = new Date("2026-02-26T10:00:00.000Z");
    const created = {
      id: "result-b",
      fetchedAt: new Date("2026-02-26T10:00:01.000Z"),
      createdAt,
    };
    const existing = [
      {
        id: "result-a",
        fetchedAt: new Date("2026-02-26T10:00:02.000Z"),
        createdAt,
      },
    ];

    const winner = (service as any).selectOrgDedupeWinner(created, existing);

    expect(winner).toEqual({
      id: "result-a",
      fetchedAt: new Date("2026-02-26T10:00:02.000Z"),
    });
  });

  it("reuses recent org-level hash matches when task-level records are missing", async () => {
    const now = new Date("2026-02-26T10:00:00.000Z");
    const prisma = {
      crawlResult: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: "result-existing-org",
              taskId: "task-old",
              orgId: "org-1",
              sourceUrl: "https://example.com/story?id=1",
              sourceUrlFingerprint: "fp-1",
              fetchedAt: now,
              markdownRef: "mongo-1",
              contentHash:
                "e2fb560b07cdf3c190ed574bf91209df9ee32938f47adad70cbfacfca19de981",
              metadata: {},
              createdAt: now
            }
          ])
      }
    };
    const service = createService(128, { prisma });
    const task = {
      id: "task-1",
      orgId: "org-1",
      targetUrl: "https://example.com/story?id=1&utm_source=x",
      config: {
        orgContentDedupeWindowHours: 24,
        urlQueryParamAllowlist: ["id"]
      }
    } as any;

    const summary = await service.persistResults(
      task,
      [
        {
          url: "https://example.com/story?utm_source=x&id=1",
          markdown: "# Headline\n\nBody paragraph"
        } as any
      ],
      {}
    );

    expect(summary).toEqual(
      expect.objectContaining({
        inserted: 0,
        skipped: 1,
        reusedResultId: "result-existing-org",
        lastFetchedAt: now
      })
    );
    expect(prisma.crawlResult.findMany).toHaveBeenCalledTimes(2);
  });

});
