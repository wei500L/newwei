import { NEVER, of, throwError, TimeoutError } from "rxjs";

import { Crawl4aiClient } from "../crawl4ai.client";
import { Crawl4aiRequestException } from "../crawl4ai.exception";

describe("Crawl4aiClient", () => {
  const httpMock = {
    get: jest.fn(),
    post: jest.fn(),
  } as any;

  const crawlSettingsMock = {
    getSettings: jest.fn(),
  } as any;

  const envMock = {
    crawl4aiConfig: {
      baseUrl: "http://crawl4ai:11235",
      jsCodeEnabled: true,
      ssrfProxyUrl: undefined,
    },
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    envMock.crawl4aiConfig.ssrfProxyUrl = undefined;
    crawlSettingsMock.getSettings = jest.fn().mockResolvedValue({
      healthCheckTtlMs: 0,
      requestTimeoutMs: 1000,
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
        storageState: '{"cookies":[]}',
        linkPreview: {
          includeInternal: true,
          includeExternal: false,
          includeSocial: true,
          maxLinks: 5,
          concurrency: 2,
          timeoutSeconds: 3,
          verbose: false,
        },
      } as any,
    });

    expect(httpMock.post).toHaveBeenCalled();
    const payload = httpMock.post.mock.calls[0]?.[1];

    expect(payload.browser_config.params).toHaveProperty("light_mode", true);
    expect(payload.browser_config.params).toHaveProperty("storage_state");
    expect(payload.browser_config.params).not.toHaveProperty("disable_images");

    expect(payload.crawler_config.params).toHaveProperty("only_text", true);
    expect(payload.crawler_config.params).not.toHaveProperty(
      "only_main_content",
    );
    expect(payload.crawler_config.params).not.toHaveProperty("extract_links");
    expect(payload.crawler_config.params).not.toHaveProperty("storage_state");

    expect(payload.crawler_config.params.markdown_generator).toEqual(
      expect.objectContaining({
        type: "DefaultMarkdownGenerator",
      }),
    );
    expect(
      payload.crawler_config.params.markdown_generator.params.content_filter
        .type,
    ).toBe("PruningContentFilter");

    expect(
      payload.crawler_config.params.link_preview_config.params,
    ).not.toHaveProperty("include_social");
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
          wordCountThreshold: 20,
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.word_count_threshold).toBe(20);
    expect(payload.crawler_config.params.remove_overlay_elements).toBe(false);
    expect(payload.crawler_config.params.css_selector).toBe(
      ".article__content,article,main",
    );
    expect(payload.crawler_config.params.excluded_tags).toEqual([
      "nav",
      "footer",
      "script",
      "style",
    ]);
  });

  it("forwards markdown citations option and BM25 filter payload", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        markdownOptions: {
          citations: true,
          contentSource: "cleaned_html",
        },
        markdownFilter: {
          type: "bm25",
          userQuery: "startup fundraising tips",
          bm25Threshold: 1.2,
          language: "english",
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.markdown_generator).toEqual(
      expect.objectContaining({
        type: "DefaultMarkdownGenerator",
        params: expect.objectContaining({
          options: expect.objectContaining({
            citations: true,
          }),
          content_filter: expect.objectContaining({
            type: "BM25ContentFilter",
            params: expect.objectContaining({
              user_query: "startup fundraising tips",
            }),
          }),
        }),
      }),
    );
    expect(
      payload.crawler_config.params.markdown_generator.params.content_filter
        .params.bm25_threshold,
    ).toBeCloseTo(1.2);
    expect(
      payload.crawler_config.params.markdown_generator.params.content_filter
        .params.language,
    ).toBe("english");
  });

  it("enables prefetch mode when requested", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true,
      } as any,
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
          detail:
            "CrawlerRunConfig.__init__() got an unexpected keyword argument 'prefetch'",
        },
      },
    };

    httpMock.post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => incompatiblePrefetchError))
      .mockReturnValueOnce(
        of({
          data: {
            results: [
              { url: "https://example.com", markdown: "# ok", success: true },
            ],
          },
        }),
      );

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    const response = await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true,
      } as any,
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
        data: "Internal Server Error",
      },
    };

    httpMock.post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => genericServerError))
      .mockReturnValueOnce(
        of({
          data: {
            results: [
              { url: "https://example.com", markdown: "# ok", success: true },
            ],
          },
        }),
      );

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    const response = await client.crawl({
      url: "https://example.com/",
      options: {
        prefetch: true,
        extractLinks: true,
      } as any,
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
          waitAfterScrollMs: 500,
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.scan_full_page).toBe(false);
    expect(payload.crawler_config.params).not.toHaveProperty("scroll_delay");
    expect(payload.crawler_config.params.virtual_scroll_config).toEqual(
      expect.objectContaining({
        type: "VirtualScrollConfig",
      }),
    );
  });

  it("applies adaptive defaults for scan_full_page dynamic pages", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        scanFullPage: true,
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.scan_full_page).toBe(true);
    expect(payload.crawler_config.params.scroll_delay).toBeCloseTo(0.35);
    expect(payload.crawler_config.params.wait_until).toBe("domcontentloaded");
    expect(payload.crawler_config.params.wait_for_timeout).toBe(8000);
    expect(payload.crawler_config.params.page_timeout).toBe(45000);
    expect(payload.crawler_config.params.delay_before_return_html).toBeCloseTo(
      0.6,
    );
    expect(payload.crawler_config.params.adjust_viewport_to_content).toBe(true);
  });

  it("serializes deep crawl components into crawler_config", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        deepCrawlStrategy: {
          type: "BFSDeepCrawlStrategy",
          params: {
            max_depth: 3,
            max_pages: 60,
          },
        },
        filterChain: {
          type: "FilterChain",
          params: {
            filters: [
              {
                type: "ContentTypeFilter",
                params: { allowed_types: ["text/html"] },
              },
            ],
          },
        },
        urlScorer: {
          type: "KeywordRelevanceScorer",
          params: {
            keywords: ["latest", "breaking"],
            weight: 0.7,
          },
        },
        adaptiveCrawling: {
          type: "StatisticalAdaptiveStrategy",
          params: {
            confidence_threshold: 0.9,
            min_pages: 10,
          },
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.deep_crawl_strategy).toEqual({
      type: "BFSDeepCrawlStrategy",
      params: {
        max_depth: 3,
        max_pages: 60,
        filter_chain: {
          type: "FilterChain",
          params: {
            filters: [
              {
                type: "ContentTypeFilter",
                params: { allowed_types: ["text/html"] },
              },
            ],
          },
        },
        url_scorer: {
          type: "KeywordRelevanceScorer",
          params: {
            keywords: ["latest", "breaking"],
            weight: 0.7,
          },
        },
        adaptive_crawling: {
          type: "StatisticalAdaptiveStrategy",
          params: {
            confidence_threshold: 0.9,
            min_pages: 10,
          },
        },
      },
    });
    expect(payload.crawler_config.params).not.toHaveProperty("filter_chain");
    expect(payload.crawler_config.params).not.toHaveProperty("url_scorer");
    expect(payload.crawler_config.params).not.toHaveProperty(
      "adaptive_crawling",
    );
  });

  it("falls back to bounded virtual scroll when scan_full_page times out", async () => {
    httpMock.post = jest
      .fn()
      .mockReturnValueOnce(throwError(() => new TimeoutError()))
      .mockReturnValueOnce(
        of({
          data: {
            results: [
              {
                url: "https://example.com",
                markdown: "# recovered",
                success: true,
              },
            ],
          },
        }),
      );

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    const response = await client.crawl({
      url: "https://example.com/",
      options: {
        scanFullPage: true,
        scrollDelayMs: 400,
      } as any,
    });

    expect(response.results).toHaveLength(1);
    expect(httpMock.post).toHaveBeenCalledTimes(2);

    const firstPayload = httpMock.post.mock.calls[0]?.[1];
    const secondPayload = httpMock.post.mock.calls[1]?.[1];

    expect(firstPayload.crawler_config.params.scan_full_page).toBe(true);
    expect(secondPayload.crawler_config.params.scan_full_page).toBe(false);
    expect(secondPayload.crawler_config.params).not.toHaveProperty(
      "scroll_delay",
    );
    expect(secondPayload.crawler_config.params.virtual_scroll_config).toEqual(
      expect.objectContaining({
        type: "VirtualScrollConfig",
        params: expect.objectContaining({
          container_selector: "body",
          scroll_count: 24,
          scroll_by: "page_height",
        }),
      }),
    );
  });

  it("enforces a hard timeout even if the request observable never completes", async () => {
    crawlSettingsMock.getSettings = jest.fn().mockResolvedValue({
      healthCheckTtlMs: 0,
      requestTimeoutMs: 50,
    });
    httpMock.post = jest.fn().mockReturnValue(NEVER);

    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await expect(
      client.crawl({
        url: "https://example.com/",
        options: { scanFullPage: true } as any,
      }),
    ).rejects.toBeInstanceOf(Crawl4aiRequestException);
  });

  it("maps advanced timing and politeness options into crawler_config", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        waitUntil: "networkidle",
        pageTimeoutMs: 45000,
        delayBeforeReturnHtmlMs: 800,
        meanDelayMs: 1200,
        maxDelayRangeMs: 350,
        semaphoreCount: 7,
        removeForms: true,
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.wait_until).toBe("networkidle");
    expect(payload.crawler_config.params.page_timeout).toBe(45000);
    expect(payload.crawler_config.params.delay_before_return_html).toBeCloseTo(
      0.8,
    );
    expect(payload.crawler_config.params.mean_delay).toBeCloseTo(1.2);
    expect(payload.crawler_config.params.max_range).toBeCloseTo(0.35);
    expect(payload.crawler_config.params.semaphore_count).toBe(7);
    expect(payload.crawler_config.params.check_robots_txt).toBe(false);
    expect(payload.crawler_config.params.remove_forms).toBe(true);
  });

  it("prefers proxy_config over proxy url", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        proxyUrl: "http://proxy-url.example:8080",
        proxyConfig: {
          server: "http://proxy-config.example:8080",
          username: "user",
          password: "pass",
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params).toHaveProperty("proxy_config");
    expect(payload.browser_config.params.proxy_config).toEqual(
      expect.objectContaining({
        server: "http://proxy-config.example:8080",
        username: "user",
        password: "pass",
      }),
    );
    expect(payload.browser_config.params).not.toHaveProperty("proxy");
  });

  it("wraps geolocation as GeolocationConfig params", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        locale: "en-US",
        timezoneId: "America/New_York",
        geolocation: {
          latitude: 40.7128,
          longitude: -74.006,
          accuracy: 120,
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.locale).toBe("en-US");
    expect(payload.crawler_config.params.timezone_id).toBe("America/New_York");
    expect(payload.crawler_config.params.geolocation).toEqual(
      expect.objectContaining({
        type: "GeolocationConfig",
        params: expect.objectContaining({
          latitude: 40.7128,
          longitude: -74.006,
          accuracy: 120,
        }),
      }),
    );
  });

  it("maps userAgentGenerator into crawl4ai-compatible generator keys", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        userAgentMode: "random",
        userAgentGenerator: {
          platform: "windows",
          browser: "chrome",
          deviceType: "desktop",
          locale: "en-US",
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.user_agent_generator_config).toEqual({
      browsers: ["Chrome"],
      os: ["Windows"],
      platforms: ["desktop"],
    });
    expect(
      payload.browser_config.params.user_agent_generator_config,
    ).not.toHaveProperty("locale");
    expect(
      payload.browser_config.params.user_agent_generator_config,
    ).not.toHaveProperty("browser");
    expect(
      payload.browser_config.params.user_agent_generator_config,
    ).not.toHaveProperty("platform");
    expect(
      payload.browser_config.params.user_agent_generator_config,
    ).not.toHaveProperty("device_type");
  });

  it("injects default sec-fetch headers when UA is random", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {} as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers).toEqual(
      expect.objectContaining({
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      }),
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua",
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua-mobile",
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua-platform",
    );
  });

  it("injects chromium sec-ch defaults when a deterministic chrome UA is provided", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers).toEqual(
      expect.objectContaining({
        "sec-ch-ua": expect.stringContaining('"Google Chrome";v="126"'),
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      }),
    );
  });

  it("uses Microsoft Edge brand when the user agent is edge", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers["sec-ch-ua"]).toContain(
      '"Microsoft Edge";v="126"',
    );
  });

  it("skips sec-ch defaults for non-chromium custom user agent", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers).toEqual(
      expect.objectContaining({
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      }),
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua",
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua-mobile",
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "sec-ch-ua-platform",
    );
  });

  it("keeps user-provided sec-ch headers without overriding values", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        browserHeaders: [
          { name: "sec-ch-ua-platform", value: '"Linux"' },
          { name: "X-Test", value: "abc" },
        ],
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers["sec-ch-ua-platform"]).toBe(
      '"Linux"',
    );
    expect(payload.browser_config.params.headers["X-Test"]).toBe("abc");
    expect(payload.browser_config.params.headers).toEqual(
      expect.objectContaining({
        "sec-ch-ua": expect.stringContaining('"Google Chrome";v="126"'),
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      }),
    );
  });

  it("rejects unsafe header names and values containing control characters", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        browserHeaders: [
          { name: "X-Good", value: "ok" },
          { name: "X-Bad\r\nInjected", value: "value" },
          { name: "X-Bad", value: "value\r\nInjected" },
        ],
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.headers).toEqual(
      expect.objectContaining({
        "X-Good": "ok",
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      }),
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty(
      "X-Bad\r\nInjected",
    );
    expect(payload.browser_config.params.headers).not.toHaveProperty("X-Bad");
  });

  it("maps advanced overrides in multiUrlConfigs", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        multiUrlConfigs: [
          {
            matcher: {
              matchMode: "prefix",
              patterns: ["https://example.com/world/"],
            },
            options: {
              waitUntil: "load",
              pageTimeoutMs: 30000,
              delayBeforeReturnHtmlMs: 1000,
              meanDelayMs: 500,
              maxDelayRangeMs: 200,
              semaphoreCount: 4,
              removeForms: true,
            },
          },
        ],
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    const config = payload.crawler_configurations?.[0]?.params;
    expect(config.wait_until).toBe("load");
    expect(config.page_timeout).toBe(30000);
    expect(config.delay_before_return_html).toBeCloseTo(1);
    expect(config.mean_delay).toBeCloseTo(0.5);
    expect(config.max_range).toBeCloseTo(0.2);
    expect(config.semaphore_count).toBe(4);
    expect(config.check_robots_txt).toBe(false);
    expect(config.remove_forms).toBe(true);
  });

  it("enforces networkidle minimum wait_for_timeout", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        waitUntil: "networkidle",
        waitForTimeoutMs: 600,
        multiUrlConfigs: [
          {
            matcher: {
              matchMode: "prefix",
              patterns: ["https://example.com/world/"],
            },
            options: {
              waitUntil: "networkidle",
              waitForTimeoutMs: 1200,
            },
          },
        ],
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.wait_for_timeout).toBe(5000);
    expect(payload.crawler_configurations?.[0]?.params?.wait_for_timeout).toBe(
      5000,
    );
  });

  it("clamps wait_for_timeout for non-networkidle waits", async () => {
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);
    await client.crawl({
      url: "https://example.com/",
      options: {
        waitUntil: "load",
        waitForTimeoutMs: 100,
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.crawler_config.params.wait_for_timeout).toBe(500);
  });

  it("routes crawl traffic through the worker SSRF proxy and preserves upstream proxy overrides", async () => {
    envMock.crawl4aiConfig.ssrfProxyUrl = "http://127.0.0.1:18080";
    const client = new Crawl4aiClient(httpMock, crawlSettingsMock, envMock);

    await client.crawl({
      url: "https://example.com/",
      options: {
        proxyConfig: {
          server: "http://localhost:7890",
          username: "user-1",
          password: "secret-1",
        },
      } as any,
    });

    const payload = httpMock.post.mock.calls[0]?.[1];
    expect(payload.browser_config.params.proxy).toBeUndefined();
    expect(payload.browser_config.params.proxy_config).toEqual({
      server: "http://127.0.0.1:18080",
      username: "__modular_ssrf_proxy__",
      password: Buffer.from(
        JSON.stringify({
          server: "http://host.docker.internal:7890",
          username: "user-1",
          password: "secret-1",
        }),
        "utf8",
      ).toString("base64url"),
    });
  });
});
