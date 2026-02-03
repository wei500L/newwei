import { of } from "rxjs";

import { Crawl4aiClient } from "../crawl4ai.client";

describe("Crawl4aiClient", () => {
  const httpMock = {
    get: jest.fn(),
    post: jest.fn()
  } as any;

  const crawlSettingsMock = {
    getSettings: jest.fn()
  } as any;

  const envMock = {
    crawl4aiConfig: {
      jsCodeEnabled: true
    }
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    crawlSettingsMock.getSettings = jest.fn().mockResolvedValue({
      healthCheckTtlMs: 0,
      requestTimeoutMs: 1000
    });
    httpMock.get = jest.fn().mockReturnValue(of({ data: {} }));
    httpMock.post = jest.fn().mockReturnValue(of({ data: { results: [] } }));
  });

  it("builds a crawl4ai 0.7.x compatible payload", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        includeImages: false,
        onlyMainContent: true,
        textMode: true,
        wordCountThreshold: 80,
        storageState: "{\"cookies\":[]}",
        linkPreview: {
          includeInternal: true,
          includeExternal: false,
          includeSocial: true,
          maxLinks: 5,
          concurrency: 2,
          timeoutSeconds: 3,
          verbose: false
        }
      } as any
    });

    expect(httpMock.post).toHaveBeenCalled();
    const payload = httpMock.post.mock.calls[0]?.[1];

    expect(payload.browser_config.params).toHaveProperty("light_mode", true);
    expect(payload.browser_config.params).toHaveProperty("storage_state");
    expect(payload.browser_config.params).not.toHaveProperty("disable_images");

    expect(payload.crawler_config.params).toHaveProperty("only_text", true);
    expect(payload.crawler_config.params).not.toHaveProperty("only_main_content");
    expect(payload.crawler_config.params).not.toHaveProperty("extract_links");
    expect(payload.crawler_config.params).not.toHaveProperty("storage_state");

    expect(payload.crawler_config.params.markdown_generator).toEqual(
      expect.objectContaining({
        type: "DefaultMarkdownGenerator"
      })
    );
    expect(payload.crawler_config.params.markdown_generator.params.content_filter.type).toBe(
      "PruningContentFilter"
    );

    expect(payload.crawler_config.params.link_preview_config.params).not.toHaveProperty("include_social");
  });

  it("applies cleanMarkdown overrides for content selection and thresholds", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        wordCountThreshold: 80,
        removeOverlayElements: true,
        cssSelector: "body",
        excludedTags: ["header"],
        cleanMarkdown: {
          cssSelector: ".article__content,article,main",
          excludedTags: ["nav", "footer", "script", "style"],
          removeOverlayElements: false,
          wordCountThreshold: 20
        }
      } as any
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.word_count_threshold).toBe(20);
    expect(payload.crawler_config.params.remove_overlay_elements).toBe(false);
    expect(payload.crawler_config.params.css_selector).toBe(".article__content,article,main");
    expect(payload.crawler_config.params.excluded_tags).toEqual(["nav", "footer", "script", "style"]);
  });

  it("enables prefetch mode when requested", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true
      } as any
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.prefetch).toBe(true);
  });
});

