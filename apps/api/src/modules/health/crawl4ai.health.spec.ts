import { of, throwError } from "rxjs";

import { Crawl4aiHealthIndicator } from "./crawl4ai.health";

describe("Crawl4aiHealthIndicator", () => {
  const http = {
    get: jest.fn(),
  } as any;
  const env = {
    crawl4aiConfig: {
      timeoutMs: 120_000,
      healthCheckTtlMs: 60_000,
    },
  } as any;
  const crawlSettings = {
    getSettings: jest.fn().mockResolvedValue({
      healthCheckTtlMs: 60_000,
    }),
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    crawlSettings.getSettings.mockResolvedValue({
      healthCheckTtlMs: 60_000,
    });
  });

  it("reports healthy when crawl4ai /health succeeds", async () => {
    http.get.mockReturnValue(of({ data: { ok: true } }));

    const indicator = new Crawl4aiHealthIndicator(http, env, crawlSettings);

    await expect(indicator.isHealthy("crawl4ai")).resolves.toEqual(
      expect.objectContaining({
        crawl4ai: expect.objectContaining({
          status: "up",
        }),
      }),
    );
  });

  it("reuses the cached health probe result within the TTL window", async () => {
    http.get.mockReturnValue(of({ data: { ok: true } }));

    const indicator = new Crawl4aiHealthIndicator(http, env, crawlSettings);

    await indicator.isHealthy("crawl4ai");
    await indicator.isHealthy("crawl4ai");

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(crawlSettings.getSettings).toHaveBeenCalledTimes(1);
  });

  it("reports unhealthy when crawl4ai /health fails", async () => {
    http.get.mockReturnValue(
      throwError(() => new Error("connect ECONNREFUSED 127.0.0.1:11235")),
    );

    const indicator = new Crawl4aiHealthIndicator(http, env, crawlSettings);

    await expect(indicator.isHealthy("crawl4ai")).rejects.toThrow(
      "crawl4ai health check failed",
    );
  });
});
