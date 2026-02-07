import { CrawlResultService } from "../crawl-result.service";

describe("CrawlResultService", () => {
  const createService = (maxBytes: number) =>
    new CrawlResultService(
      {} as any,
      {
        crawl4aiConfig: {
          media: { fetchTimeoutMs: 1000, maxBytes, maxPerResult: 10 }
        }
      } as any,
      {} as any
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
        sourceUrl: dataUri,
        dataUri
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
});

