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
});

