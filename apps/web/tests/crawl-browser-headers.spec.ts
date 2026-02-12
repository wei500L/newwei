import { describe, expect, it } from "vitest";

import {
  applyAutoBrowserHeadersToCrawlOptions,
  buildAutoBrowserHeadersForCrawlOptions,
  mergeBrowserHeaders,
  normalizeBrowserHeaders,
} from "../lib/crawl-browser-headers";

describe("crawl browser headers", () => {
  it("only injects sec-fetch defaults when UA is random", () => {
    const headers = buildAutoBrowserHeadersForCrawlOptions({
      userAgentMode: "random",
    });

    expect(headers).toEqual([
      { name: "sec-fetch-site", value: "none" },
      { name: "sec-fetch-mode", value: "navigate" },
    ]);
  });

  it("builds sec-ch and sec-fetch headers for chromium user agents", () => {
    const headers = buildAutoBrowserHeadersForCrawlOptions({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    const byName = new Map(
      headers.map((header) => [header.name.toLowerCase(), header.value]),
    );
    expect(byName.get("sec-ch-ua")).toContain('"Chromium";v="122"');
    expect(byName.get("sec-ch-ua-mobile")).toBe("?0");
    expect(byName.get("sec-ch-ua-platform")).toBe('"Windows"');
    expect(byName.get("sec-fetch-site")).toBe("none");
    expect(byName.get("sec-fetch-mode")).toBe("navigate");
  });

  it("uses Microsoft Edge brand for edge user agents", () => {
    const headers = buildAutoBrowserHeadersForCrawlOptions({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    });

    const byName = new Map(
      headers.map((header) => [header.name.toLowerCase(), header.value]),
    );
    expect(byName.get("sec-ch-ua")).toContain('"Microsoft Edge";v="126"');
  });

  it("skips sec-ch hints for firefox and keeps sec-fetch defaults", () => {
    const headers = buildAutoBrowserHeadersForCrawlOptions({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0",
    });

    expect(headers).toEqual([
      { name: "sec-fetch-site", value: "none" },
      { name: "sec-fetch-mode", value: "navigate" },
    ]);
  });

  it("merges auto headers without overriding existing values", () => {
    const existing = normalizeBrowserHeaders([
      { name: "Sec-CH-UA", value: '"Custom";v="1"' },
      { name: "sec-fetch-site", value: "same-origin" },
    ]);
    const auto = buildAutoBrowserHeadersForCrawlOptions({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const merged = mergeBrowserHeaders(existing, auto);
    const byName = new Map(
      merged.map((header) => [header.name.toLowerCase(), header]),
    );

    expect(byName.get("sec-ch-ua")?.value).toBe('"Custom";v="1"');
    expect(byName.get("sec-fetch-site")?.value).toBe("same-origin");
    expect(byName.get("sec-fetch-mode")?.value).toBe("navigate");
    expect(byName.get("sec-ch-ua-mobile")?.value).toBe("?0");
  });

  it("applies dynamic headers into crawl options", () => {
    const next = applyAutoBrowserHeadersToCrawlOptions({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      browserHeaders: [{ name: "accept-language", value: "en-US,en;q=0.9" }],
    });

    const headers = Array.isArray(next.browserHeaders)
      ? next.browserHeaders
      : [];
    const byName = new Map(
      headers.map((header) => [
        String((header as { name?: string }).name).toLowerCase(),
        header,
      ]),
    );

    expect(byName.get("accept-language")).toBeTruthy();
    expect(byName.get("sec-fetch-site")).toBeTruthy();
    expect(byName.get("sec-fetch-mode")).toBeTruthy();
    expect(byName.get("sec-ch-ua")).toBeUndefined();
    expect(byName.get("sec-ch-ua-mobile")).toBeUndefined();
    expect(byName.get("sec-ch-ua-platform")).toBeUndefined();
  });

  it("drops unsafe browser header values with CRLF control characters", () => {
    const headers = normalizeBrowserHeaders([
      { name: "X-Good", value: "ok" },
      { name: "X-Bad\r\nInjected", value: "bad" },
      { name: "X-Bad", value: "bad\r\nInjected" },
    ]);

    expect(headers).toEqual([{ name: "X-Good", value: "ok" }]);
  });
});
