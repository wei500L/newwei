import { of, throwError } from "rxjs";

import { Crawl4aiSsrfProxyHealthIndicator } from "./crawl4ai-ssrf-proxy.health";

describe("Crawl4aiSsrfProxyHealthIndicator", () => {
  const http = {
    post: jest.fn(),
  } as any;
  const crawlSettings = {
    getSettings: jest.fn().mockResolvedValue({
      healthCheckTtlMs: 60_000,
    }),
  } as any;

  const env = {
    crawl4aiConfig: {
      timeoutMs: 120_000,
      ssrfProxyUrl: "http://127.0.0.1:18080",
      healthCheckTtlMs: 60_000,
    },
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    crawlSettings.getSettings.mockResolvedValue({
      healthCheckTtlMs: 60_000,
    });
  });

  it("reports healthy when the crawl probe succeeds through the SSRF proxy", async () => {
    http.post.mockReturnValue(
      of({
        data: {
          results: [{ success: true }],
        },
      }),
    );

    const indicator = new Crawl4aiSsrfProxyHealthIndicator(http, env, crawlSettings);
    await expect(indicator.isHealthy("crawl4aiSsrfProxy")).resolves.toEqual(
      expect.objectContaining({
        crawl4aiSsrfProxy: expect.objectContaining({
          status: "up",
          url: "http://127.0.0.1:18080",
        }),
      }),
    );
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it("fails when the SSRF proxy is disabled", async () => {
    const indicator = new Crawl4aiSsrfProxyHealthIndicator(http, {
      crawl4aiConfig: {
        timeoutMs: 120_000,
        ssrfProxyUrl: undefined,
        healthCheckTtlMs: 60_000,
      },
    } as any, crawlSettings);

    await expect(indicator.isHealthy("crawl4aiSsrfProxy")).rejects.toThrow(
      "crawl4ai SSRF proxy is not configured",
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it("fails when the probe request errors", async () => {
    http.post.mockReturnValue(
      throwError(() => new Error("connect ECONNREFUSED 127.0.0.1:18080")),
    );

    const indicator = new Crawl4aiSsrfProxyHealthIndicator(http, env, crawlSettings);
    await expect(indicator.isHealthy("crawl4aiSsrfProxy")).rejects.toThrow(
      "connect ECONNREFUSED 127.0.0.1:18080",
    );
  });

  it("reuses the cached SSRF proxy probe within the TTL window", async () => {
    http.post.mockReturnValue(
      of({
        data: {
          results: [{ success: true }],
        },
      }),
    );

    const indicator = new Crawl4aiSsrfProxyHealthIndicator(http, env, crawlSettings);
    await indicator.isHealthy("crawl4aiSsrfProxy");
    await indicator.isHealthy("crawl4aiSsrfProxy");

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(crawlSettings.getSettings).toHaveBeenCalledTimes(1);
  });
});
