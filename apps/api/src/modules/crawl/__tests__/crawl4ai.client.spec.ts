import { NEVER, of, throwError } from "rxjs";

import { Crawl4aiClient } from "../crawl4ai.client";
import { Crawl4aiRequestException } from "../crawl4ai.exception";

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

  it("forwards markdown citations option and BM25 filter payload", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        markdownOptions: {
          citations: true,
          contentSource: "cleaned_html"
        },
        markdownFilter: {
          type: "bm25",
          userQuery: "startup fundraising tips",
          bm25Threshold: 1.2,
          language: "english"
        }
      } as any
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.markdown_generator).toEqual(
      expect.objectContaining({
        type: "DefaultMarkdownGenerator",
        params: expect.objectContaining({
          options: expect.objectContaining({
            citations: true
          }),
          content_filter: expect.objectContaining({
            type: "BM25ContentFilter",
            params: expect.objectContaining({ user_query: "startup fundraising tips" })
          })
        })
      })
    );
    expect(payload.crawler_config.params.markdown_generator.params.content_filter.params.bm25_threshold).toBeCloseTo(1.2);
    expect(payload.crawler_config.params.markdown_generator.params.content_filter.params.language).toBe("english");
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

  it("retries without prefetch when crawl4ai runtime is incompatible", async () => {
    const incompatiblePrefetchError = {
      message: "Request failed with status code 500",
      response: {
        status: 500,
        data: {
          detail: "CrawlerRunConfig.__init__() got an unexpected keyword argument 'prefetch'"
        }
      }
    };

    httpMock.post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => incompatiblePrefetchError))
      .mockReturnValueOnce(
        of({
          data: {
            results: [{ url: "https://example.com", markdown: "# ok", success: true }]
          }
        })
      );

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    const response = await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true
      } as any
    });

    expect(httpMock.post).toHaveBeenCalledTimes(2);
    const firstPayload = httpMock.post.mock.calls[0]?.[1];
    const secondPayload = httpMock.post.mock.calls[1]?.[1];

    expect(firstPayload.crawler_config.params.prefetch).toBe(true);
    expect(secondPayload.crawler_config.params).not.toHaveProperty("prefetch");
    expect(response.results).toHaveLength(1);
  });

  it("retries without prefetch on generic 500 response when prefetch is enabled", async () => {
    const genericServerError = {
      message: "Request failed with status code 500",
      response: {
        status: 500,
        data: "Internal Server Error"
      }
    };

    httpMock.post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => genericServerError))
      .mockReturnValueOnce(
        of({
          data: {
            results: [{ url: "https://example.com", markdown: "# ok", success: true }]
          }
        })
      );

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    const response = await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true
      } as any
    });

    expect(httpMock.post).toHaveBeenCalledTimes(2);
    const firstPayload = httpMock.post.mock.calls[0]?.[1];
    const secondPayload = httpMock.post.mock.calls[1]?.[1];

    expect(firstPayload.crawler_config.params.prefetch).toBe(true);
    expect(secondPayload.crawler_config.params).not.toHaveProperty("prefetch");
    expect(response.results).toHaveLength(1);
  });

  it("disables scan_full_page when virtualScroll is configured", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        scanFullPage: true,
        scrollDelayMs: 1000,
        virtualScroll: {
          containerSelector: "body",
          scrollCount: 3,
          scrollBy: "page_height",
          waitAfterScrollMs: 500
        }
      } as any
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.scan_full_page).toBe(false);
    expect(payload.crawler_config.params).not.toHaveProperty("scroll_delay");
    expect(payload.crawler_config.params.virtual_scroll_config).toEqual(
      expect.objectContaining({
        type: "VirtualScrollConfig"
      })
    );
  });

  it("enforces a hard timeout even if the request observable never completes", async () => {
    crawlSettingsMock.getSettings = jest.fn().mockResolvedValue({
      healthCheckTtlMs: 0,
      requestTimeoutMs: 50
    });
    httpMock.post = jest.fn().mockReturnValue(NEVER);

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await expect(
      client.crawl({
        url: "https://example.com/",
        options: { scanFullPage: true } as any
      })
    ).rejects.toBeInstanceOf(Crawl4aiRequestException);
  });
});
