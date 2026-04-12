jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

import { BadRequestException } from "@nestjs/common";
import { gzipSync } from "node:zlib";

import { CrawlMetadataService } from "../crawl-metadata.service";

describe("CrawlMetadataService pattern matching", () => {
  const normalizePattern = (service: CrawlMetadataService, pattern?: string) =>
    (service as any).normalizePattern(pattern) as
      | undefined
      | ((url: string) => boolean);

  it("returns undefined for empty patterns", () => {
    const service = new CrawlMetadataService();
    expect(normalizePattern(service, undefined)).toBeUndefined();
    expect(normalizePattern(service, "")).toBeUndefined();
    expect(normalizePattern(service, "   ")).toBeUndefined();
  });

  it("matches full url with '*' and '?' wildcards (case-insensitive)", () => {
    const service = new CrawlMetadataService();
    const matcher = normalizePattern(
      service,
      "HTTPS://Example.com/path/*/it?m",
    );

    expect(matcher).toBeDefined();
    expect(matcher?.("https://example.com/path/one/item")).toBe(true);
    expect(matcher?.("https://example.com/path/one/items")).toBe(false);
    expect(matcher?.("https://example.com/other/one/item")).toBe(false);
  });

  it("rejects overly long patterns", () => {
    const service = new CrawlMetadataService();
    expect(normalizePattern(service, "a".repeat(10_000))).toBeUndefined();
  });

  it("rejects patterns with too many wildcards", () => {
    const service = new CrawlMetadataService();
    expect(normalizePattern(service, "*".repeat(1_000))).toBeUndefined();
  });

  it("handles patterns that would be costly as regex without hanging", () => {
    const service = new CrawlMetadataService();
    const matcher = normalizePattern(service, "*a*a*a*a*a*a*a*a*a*a*");
    const input = "a".repeat(50_000);

    expect(matcher).toBeDefined();
    expect(matcher?.(input)).toBe(true);
  });
});

describe("CrawlMetadataService sitemap discovery", () => {
  const originalFetch = global.fetch;
  const makeHeaders = (headers: Record<string, string>) => ({
    get: (key: string) => headers[key.toLowerCase()] ?? null,
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("clamps future timestamps parsed from url path to now", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
    try {
      const service = new CrawlMetadataService();
      const ts = (service as any).parsePublishedAtFromUrl(
        "https://example.com/2026/08/05/future-story",
      );
      expect(ts).toBe(Date.parse("2026-02-15T12:00:00.000Z"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("discovers urls from nested gzipped sitemap indexes", async () => {
    const sitemapIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap>
          <loc>https://example.com/sitemap-posts.xml.gz</loc>
        </sitemap>
      </sitemapindex>`;

    const urlsetXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a/1</loc></url>
        <url><loc>https://example.com/b/2</loc></url>
      </urlset>`;

    const gzipped = gzipSync(Buffer.from(urlsetXml, "utf8"));

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://example.com/sitemap.xml") {
        const buffer = Buffer.from(sitemapIndexXml, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
          text: async () => buffer.toString("utf8"),
        } as any;
      }

      if (url === "https://example.com/sitemap-posts.xml.gz") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/x-gzip" }),
          arrayBuffer: async () => gzipped,
          text: async () => gzipped.toString("utf8"),
        } as any;
      }

      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
        text: async () => "",
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const urls = await service.discoverSitemapUrls({
      domain: "https://example.com",
      pattern: "https://example.com/a/*",
      maxUrls: 10,
      requestTimeoutMs: 5000,
    });

    expect(urls).toEqual(["https://example.com/a/1"]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      expect.any(Object),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap-posts.xml.gz",
      expect.any(Object),
    );
  });

  it("does not truncate sitemapindex children to the first five entries", async () => {
    const sitemapIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-3.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-4.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-5.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-6.xml</loc></sitemap>
      </sitemapindex>`;

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://example.com/sitemap.xml") {
        const buffer = Buffer.from(sitemapIndexXml, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
        } as any;
      }

      if (url.startsWith("https://example.com/sitemap-")) {
        const isTarget = url.endsWith("6.xml");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>${isTarget ? "https://example.com/target/one" : "https://example.com/other/path"}</loc></url>
          </urlset>`;
        const buffer = Buffer.from(xml, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
        } as any;
      }

      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const urls = await service.discoverSitemapUrls({
      domain: "https://example.com",
      pattern: "https://example.com/target/*",
      maxUrls: 10,
      requestTimeoutMs: 5000,
    });

    expect(urls).toEqual(["https://example.com/target/one"]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap-6.xml",
      expect.any(Object),
    );
  });

  it("avoids infinite loops when sitemap indexes reference each other", async () => {
    const rootIndex = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
      </sitemapindex>`;
    const nestedIndex = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-c.xml</loc></sitemap>
      </sitemapindex>`;
    const leafUrlset = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/news/final</loc></url>
      </urlset>`;

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://example.com/sitemap.xml") {
        const buffer = Buffer.from(rootIndex, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
        } as any;
      }
      if (url === "https://example.com/sitemap-b.xml") {
        const buffer = Buffer.from(nestedIndex, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
        } as any;
      }
      if (url === "https://example.com/sitemap-c.xml") {
        const buffer = Buffer.from(leafUrlset, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
        } as any;
      }
      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const urls = await service.discoverSitemapUrls({
      domain: "https://example.com",
      maxUrls: 1,
      requestTimeoutMs: 5000,
      discoveryMode: "common_paths",
    });

    const fetchedUrls = (global.fetch as jest.Mock).mock.calls.map(
      (call) => call[0],
    );
    expect(urls).toEqual(["https://example.com/news/final"]);
    expect(
      fetchedUrls.filter((url) => url === "https://example.com/sitemap.xml")
        .length,
    ).toBe(1);
    expect(
      fetchedUrls.filter((url) => url === "https://example.com/sitemap-b.xml")
        .length,
    ).toBe(1);
    expect(
      fetchedUrls.filter((url) => url === "https://example.com/sitemap-c.xml")
        .length,
    ).toBe(1);
  });

  it("reuses cached sitemap body when the server returns 304", async () => {
    const cacheData = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => (cacheData.get(key) as any) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        cacheData.set(key, value);
      }),
    };
    const sitemapUrlset = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/news/cached</loc></url>
      </urlset>`;

    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["if-none-match"] === '"seed-v1"') {
        return {
          ok: false,
          status: 304,
          headers: makeHeaders({ etag: '"seed-v1"' }),
          arrayBuffer: async () => Buffer.from("", "utf8"),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({
          "content-type": "application/xml",
          etag: '"seed-v1"',
        }),
        arrayBuffer: async () => Buffer.from(sitemapUrlset, "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService(undefined, cache as any);
    const firstRun = await service.discoverSitemapUrls({
      domain: "https://example.com",
      maxUrls: 1,
      requestTimeoutMs: 5000,
      discoveryMode: "common_paths",
    });
    const secondRun = await service.discoverSitemapUrls({
      domain: "https://example.com",
      maxUrls: 1,
      requestTimeoutMs: 5000,
      discoveryMode: "common_paths",
    });

    expect(firstRun).toEqual(["https://example.com/news/cached"]);
    expect(secondRun).toEqual(["https://example.com/news/cached"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const secondRequestHeaders = (global.fetch as jest.Mock).mock.calls[1]?.[1]
      ?.headers as Record<string, string>;
    expect(secondRequestHeaders["if-none-match"]).toBe('"seed-v1"');
  });

  it("extracts sitemap lastmod/news dates and applies freshness filtering", async () => {
    const sitemapUrlset = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://example.com/news/old-story</loc>
          <lastmod>2025-01-01T00:00:00Z</lastmod>
        </url>
        <url>
          <loc>https://example.com/news/new-story</loc>
          <news:news>
            <news:publication>
              <news:publication_date>2026-02-14T10:30:00Z</news:publication_date>
            </news:publication>
          </news:news>
        </url>
      </urlset>`;

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://example.com/sitemap.xml") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => Buffer.from(sitemapUrlset, "utf8"),
        } as any;
      }
      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const candidates = await service.discoverSitemapCandidates({
      domain: "https://example.com",
      maxUrls: 10,
      freshnessCutoffTs: Date.parse("2026-02-01T00:00:00Z"),
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        url: "https://example.com/news/new-story",
      }),
    ]);
    expect(candidates[0]?.publishedAtTs).toBe(
      Date.parse("2026-02-14T10:30:00Z"),
    );
  });

  it("assigns crawledAt timestamp when sitemap url has no publish signal", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
    try {
      const sitemapUrlset = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://example.com/news/no-date-signal</loc>
          </url>
        </urlset>`;

      global.fetch = jest.fn(async (url: string) => {
        if (url === "https://example.com/sitemap.xml") {
          return {
            ok: true,
            status: 200,
            headers: makeHeaders({ "content-type": "application/xml" }),
            arrayBuffer: async () => Buffer.from(sitemapUrlset, "utf8"),
          } as any;
        }
        return {
          ok: false,
          status: 404,
          headers: makeHeaders({}),
          arrayBuffer: async () => Buffer.from("", "utf8"),
        } as any;
      }) as any;

      const service = new CrawlMetadataService();
      const candidates = await service.discoverSitemapCandidates({
        domain: "https://example.com",
        maxUrls: 10,
      });

      expect(candidates).toEqual([
        expect.objectContaining({
          url: "https://example.com/news/no-date-signal",
          crawledAtTs: Date.parse("2026-02-15T12:00:00.000Z"),
        }),
      ]);
      expect(candidates[0]?.publishedAtTs).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips stale sitemapindex children by lastmod when freshness cutoff is set", async () => {
    const rootIndex = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap>
          <loc>https://example.com/sitemap-old.xml</loc>
          <lastmod>2024-01-01T00:00:00Z</lastmod>
        </sitemap>
        <sitemap>
          <loc>https://example.com/sitemap-fresh.xml</loc>
          <lastmod>2026-02-14T00:00:00Z</lastmod>
        </sitemap>
      </sitemapindex>`;
    const freshChild = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/news/fresh-child</loc></url>
      </urlset>`;

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://example.com/sitemap.xml") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => Buffer.from(rootIndex, "utf8"),
        } as any;
      }
      if (url === "https://example.com/sitemap-fresh.xml") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => Buffer.from(freshChild, "utf8"),
        } as any;
      }
      if (url === "https://example.com/sitemap-old.xml") {
        throw new Error("stale child should not be fetched");
      }
      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const candidates = await service.discoverSitemapCandidates({
      domain: "https://example.com",
      maxUrls: 10,
      freshnessCutoffTs: Date.parse("2026-01-01T00:00:00Z"),
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        url: "https://example.com/news/fresh-child",
      }),
    ]);
    const fetchedUrls = (global.fetch as jest.Mock).mock.calls.map(
      (call) => call[0],
    );
    expect(fetchedUrls).toContain("https://example.com/sitemap-fresh.xml");
    expect(fetchedUrls).not.toContain("https://example.com/sitemap-old.xml");
  });

  it("falls back to an unconditional fetch when 304 is returned without cached body", async () => {
    const cache = {
      get: jest
        .fn()
        .mockResolvedValueOnce({
          etag: '"seed-v1"',
          lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
          updatedAt: Date.now(),
        })
        .mockResolvedValueOnce(null),
      set: jest.fn(async () => undefined),
    };
    const urlsetXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/news/fallback</loc></url>
      </urlset>`;

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url !== "https://example.com/sitemap.xml") {
        return {
          ok: false,
          status: 404,
          headers: makeHeaders({}),
          arrayBuffer: async () => Buffer.from("", "utf8"),
        } as any;
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["if-none-match"] === '"seed-v1"') {
        return {
          ok: false,
          status: 304,
          headers: makeHeaders({
            etag: '"seed-v1"',
            "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
          }),
          arrayBuffer: async () => Buffer.from("", "utf8"),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({
          "content-type": "application/xml",
          etag: '"seed-v2"',
        }),
        arrayBuffer: async () => Buffer.from(urlsetXml, "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService(undefined, cache as any);
    const urls = await service.discoverSitemapUrls({
      domain: "https://example.com",
      maxUrls: 1,
      requestTimeoutMs: 5000,
      discoveryMode: "common_paths",
    });

    expect(urls).toEqual(["https://example.com/news/fallback"]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      expect.any(Object),
    );
    expect(cache.set).toHaveBeenCalled();
  });

  it("discovers sitemap seeds from robots.txt before common sitemap paths", async () => {
    const robotsPayload = `User-agent: *\nDisallow:\nSitemap: https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml\nSitemap: https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml\n`;
    const newsIndex = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap>
          <loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap-1/?outputType=xml</loc>
        </sitemap>
      </sitemapindex>`;
    const newsChild = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url>
          <loc>https://www.reuters.com/world/europe/example-story/</loc>
          <lastmod>2026-03-18T06:00:00Z</lastmod>
        </url>
      </urlset>`;

    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://www.reuters.com/robots.txt") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "text/plain" }),
          arrayBuffer: async () => Buffer.from(robotsPayload, "utf8"),
        } as any;
      }
      if (
        url ===
        "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml"
      ) {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => Buffer.from(newsIndex, "utf8"),
        } as any;
      }
      if (
        url ===
        "https://www.reuters.com/arc/outboundfeeds/news-sitemap-1/?outputType=xml"
      ) {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => Buffer.from(newsChild, "utf8"),
        } as any;
      }
      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const discovered = await service.discoverSitemap({
      domain: "https://www.reuters.com",
      maxUrls: 10,
      discoveryMode: "robots",
    });

    expect(discovered.candidates).toEqual([
      expect.objectContaining({
        url: "https://www.reuters.com/world/europe/example-story/",
      }),
    ]);
    expect(discovered.diagnostics).toEqual(
      expect.objectContaining({
        discoveryMode: "robots",
        seedMethod: "robots",
        parsedSitemaps: 2,
        candidateCount: 1,
      }),
    );
    expect(discovered.diagnostics.robotsDiscoveredSitemaps).toContain(
      "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
    );
    expect(discovered.diagnostics.attemptedSitemaps).toContain(
      "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
    );
  });
});

describe("CrawlMetadataService list discovery (crawl4ai)", () => {
  it("extracts and filters urls from crawl4ai link results", async () => {
    const crawl = jest.fn(async () => ({
      results: [
        {
          success: true,
          links: {
            internal: [
              { href: "/article/one/" },
              { href: "https://www.politico.eu/article/two/" },
              { href: "/newsletter/" },
              { href: "javascript:void(0)" },
              { href: "#anchor" },
            ],
            external: [{ href: "https://twitter.com/politico" }],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const fetchSpy = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as any;

    try {
      const urls = await service.discoverListUrls({
        url: "https://www.politico.eu/latest/",
        domain: "https://www.politico.eu",
        pattern: "https://www.politico.eu/article/*",
        maxUrls: 10,
      });

      expect(urls).toEqual([
        "https://www.politico.eu/article/one/",
        "https://www.politico.eu/article/two/",
      ]);
      expect(crawl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://www.politico.eu/latest/",
        }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("sanitizes list discovery crawl options before calling crawl4ai", async () => {
    const crawl = jest.fn(async () => ({
      results: [
        {
          success: true,
          url: "https://www.politico.eu/latest/",
          links: {
            internal: [{ href: "/article/one/" }],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverListUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      pattern: "https://www.politico.eu/article/*",
      maxUrls: 10,
      crawlOptions: {
        waitUntil: "networkidle",
        waitForTimeoutMs: 1200,
        pageTimeoutMs: 999999,
        additionalUrls: ["https://www.politico.eu/extra/"],
        multiUrlConfigs: [
          {
            name: "override",
            urls: ["https://www.politico.eu/other/"],
          },
        ],
      },
    });

    expect(urls).toEqual(["https://www.politico.eu/article/one/"]);
    const payload = crawl.mock.calls[0]?.[0] as {
      options?: Record<string, unknown>;
    };
    expect(payload.options).toEqual(
      expect.objectContaining({
        extractLinks: true,
        prefetch: true,
        waitUntil: "networkidle",
        waitForTimeoutMs: 5000,
        pageTimeoutMs: 180000,
      }),
    );
    expect(payload.options?.additionalUrls).toBeUndefined();
    expect(payload.options?.multiUrlConfigs).toBeUndefined();
  });

  it("rejects list discovery crawl options containing legacy proxy overrides", async () => {
    const crawl = jest.fn();
    const service = new CrawlMetadataService({ crawl } as any);

    await expect(
      service.discoverListUrls({
        url: "https://www.politico.eu/latest/",
        crawlOptions: {
          proxyUrl: "http://proxy.example.com:8080",
        },
      }),
    ).rejects.toThrow("Unsupported crawl config");
    expect(crawl).not.toHaveBeenCalled();
  });

  it("prefers the successful seed-url result when crawl4ai returns multiple results", async () => {
    const crawl = jest.fn(async () => ({
      results: [
        {
          success: true,
          url: "https://www.politico.eu/other/",
          links: {
            internal: [{ href: "/article/wrong/" }],
          },
        },
        {
          success: true,
          url: "https://www.politico.eu/latest/",
          links: {
            internal: [{ href: "/article/right/" }],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverListUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      pattern: "https://www.politico.eu/article/*",
      maxUrls: 10,
    });

    expect(urls).toEqual(["https://www.politico.eu/article/right/"]);
  });

  it("follows pagination links and aggregates article URLs from multiple list pages", async () => {
    const crawl = jest
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            success: true,
            url: "https://www.politico.eu/latest/",
            links: {
              internal: [
                { href: "/article/one/" },
                { href: "/latest/?page=2", text: "Next" },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            success: true,
            url: "https://www.politico.eu/latest/?page=2",
            links: {
              internal: [{ href: "/article/two/" }],
            },
          },
        ],
      });

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverListUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      pattern: "https://www.politico.eu/article/*",
      maxUrls: 10,
      listMaxPages: 3,
      listPageConcurrency: 1,
      followPagination: true,
    });

    expect(urls).toEqual([
      "https://www.politico.eu/article/one/",
      "https://www.politico.eu/article/two/",
    ]);
    expect(crawl).toHaveBeenCalledTimes(2);
    expect(crawl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://www.politico.eu/latest/?page=2",
      }),
    );
  });

  it("does not follow pagination links when followPagination is false", async () => {
    const crawl = jest.fn(async () => ({
      results: [
        {
          success: true,
          url: "https://www.politico.eu/latest/",
          links: {
            internal: [
              { href: "/article/one/" },
              { href: "/latest/?page=2", text: "Next" },
            ],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverListUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      pattern: "https://www.politico.eu/article/*",
      maxUrls: 10,
      listMaxPages: 3,
      listPageConcurrency: 1,
      followPagination: false,
    });

    expect(urls).toEqual(["https://www.politico.eu/article/one/"]);
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  it("falls back to HTML parsing when crawl4ai is unavailable", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url: string) => {
      if (url === "https://www.politico.eu/latest/") {
        const html = `
          <html>
            <body>
              <a href="/article/fallback-one/">one</a>
              <a href="/newsletter/daily/">newsletter</a>
            </body>
          </html>
        `;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "text/html" },
          text: async () => html,
          arrayBuffer: async () => Buffer.from(html, "utf8"),
        } as any;
      }
      return {
        ok: false,
        status: 404,
        headers: { get: () => "text/html" },
        text: async () => "",
        arrayBuffer: async () => Buffer.from("", "utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    try {
      const urls = await service.discoverListUrls({
        url: "https://www.politico.eu/latest/",
        domain: "https://www.politico.eu",
        pattern: "https://www.politico.eu/article/*",
        maxUrls: 10,
      });
      expect(urls).toEqual(["https://www.politico.eu/article/fallback-one/"]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("CrawlMetadataService deep discovery (crawl4ai)", () => {
  it("discovers article URLs across paginated/secondary hubs and returns latest first", async () => {
    const crawl = jest.fn(async ({ url }: { url: string }) => {
      if (url === "https://www.politico.eu/latest/") {
        return {
          results: [
            {
              success: true,
              url,
              links: {
                internal: [
                  { href: "/2026/02/13/politics/story-one/", total_score: 0.4 },
                  { href: "/latest/?page=2", text: "Next", total_score: 0.3 },
                  { href: "/world/", text: "World", total_score: 0.35 },
                  { href: "/newsletter/daily/" },
                ],
              },
            },
          ],
        };
      }
      if (url === "https://www.politico.eu/latest/?page=2") {
        return {
          results: [
            {
              success: true,
              url,
              links: {
                internal: [
                  {
                    href: "/2026/02/11/economy/story-three/",
                    total_score: 0.45,
                  },
                ],
              },
            },
          ],
        };
      }
      if (url === "https://www.politico.eu/world/") {
        return {
          results: [
            {
              success: true,
              url,
              links: {
                internal: [
                  { href: "/2026/02/12/world/story-two/", total_score: 0.5 },
                ],
              },
            },
          ],
        };
      }
      return { results: [] };
    });

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverDeepUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      maxUrls: 20,
      deep: {
        maxPages: 12,
        maxDepth: 2,
        pageConcurrency: 1,
        timeBudgetSeconds: 30,
        enableSecondaryHubs: true,
      },
    });

    expect(urls).toEqual([
      "https://www.politico.eu/2026/02/13/politics/story-one/",
      "https://www.politico.eu/2026/02/12/world/story-two/",
      "https://www.politico.eu/2026/02/11/economy/story-three/",
    ]);
    expect(crawl).toHaveBeenCalledTimes(3);
  });

  it("prioritizes publish date over link score in deep ranking", async () => {
    const crawl = jest.fn(async ({ url }: { url: string }) => ({
      results: [
        {
          success: true,
          url,
          links: {
            internal: [
              { href: "/2026/02/10/world/newer-story/", total_score: 0.2 },
              { href: "/2026/01/01/world/older-story/", total_score: 0.95 },
            ],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverDeepUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      maxUrls: 10,
      deep: {
        maxPages: 5,
        maxDepth: 1,
        pageConcurrency: 1,
      },
    });

    expect(urls).toEqual([
      "https://www.politico.eu/2026/02/10/world/newer-story/",
      "https://www.politico.eu/2026/01/01/world/older-story/",
    ]);
  });

  it("filters non-article links during deep discovery", async () => {
    const crawl = jest.fn(async ({ url }: { url: string }) => ({
      results: [
        {
          success: true,
          url,
          links: {
            internal: [
              { href: "/newsletter/daily/" },
              { href: "/section/politics/" },
              { href: "/topics/europe/" },
              { href: "/article/2026-02-13-valid-story/" },
            ],
          },
        },
      ],
    }));

    const service = new CrawlMetadataService({ crawl } as any);
    const urls = await service.discoverDeepUrls({
      url: "https://www.politico.eu/latest/",
      domain: "https://www.politico.eu",
      pattern: "https://www.politico.eu/article/*",
      maxUrls: 10,
      deep: {
        maxPages: 5,
        maxDepth: 1,
      },
    });

    expect(urls).toEqual([
      "https://www.politico.eu/article/2026-02-13-valid-story/",
    ]);
  });

  it("keeps deep candidates when publish timestamps cannot be determined", async () => {
    const crawl = jest.fn(async ({ url }: { url: string }) => ({
      results: [
        {
          success: true,
          url,
          links: {
            internal: [
              { href: "/article/story-alpha-no-date/", total_score: 0.95 },
              { href: "/article/story-bravo-no-date/", total_score: 0.9 },
            ],
          },
        },
      ],
    }));
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<html><head></head><body></body></html>",
      arrayBuffer: async () => Buffer.from("", "utf8"),
    })) as any;

    const service = new CrawlMetadataService({ crawl } as any);
    try {
      const urls = await service.discoverDeepUrls({
        url: "https://www.politico.eu/latest/",
        domain: "https://www.politico.eu",
        pattern: "https://www.politico.eu/article/*",
        maxUrls: 10,
        deep: {
          maxPages: 5,
          maxDepth: 1,
          pageConcurrency: 1,
          headFetchTopK: 10,
          timeBudgetSeconds: 30,
        },
      });
      expect(urls).toEqual([
        "https://www.politico.eu/article/story-alpha-no-date/",
        "https://www.politico.eu/article/story-bravo-no-date/",
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws explicit error when crawl4ai client is unavailable", async () => {
    const service = new CrawlMetadataService();
    await expect(
      service.discoverDeepUrls({
        url: "https://www.politico.eu/latest/",
        domain: "https://www.politico.eu",
        pattern: "https://www.politico.eu/article/*",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: BadRequestException.name,
        message: expect.stringContaining("SEED_DEEP_CRAWL4AI_UNAVAILABLE"),
      }),
    );
  });
});

describe("CrawlMetadataService RSS prefetched candidates", () => {
  const originalFetch = global.fetch;
  const makeHeaders = (headers: Record<string, string>) => ({
    get: (key: string) => headers[key.toLowerCase()] ?? null,
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("prefers RSS content over description and falls back when needed", async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <item>
            <title>Story A</title>
            <link>https://example.com/a</link>
            <description><![CDATA[Description A]]></description>
            <content:encoded><![CDATA[<p>Body A</p>]]></content:encoded>
            <author>Alice</author>
            <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Story B</title>
            <link>https://example.com/b</link>
            <description><![CDATA[Description B only]]></description>
          </item>
          <item>
            <title>Story C</title>
            <link>https://example.com/c</link>
            <description><![CDATA[   ]]></description>
          </item>
        </channel>
      </rss>`;

    global.fetch = jest.fn(async () => {
      const buffer = Buffer.from(rssXml, "utf8");
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "application/rss+xml" }),
        arrayBuffer: async () => buffer,
        text: async () => buffer.toString("utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const candidates = await service.discoverRssCandidates({
      feedUrl: "https://example.com/feed.xml",
      maxUrls: 10,
      requestTimeoutMs: 5000,
    });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      url: "https://example.com/a",
      prefetchedArticle: {
        title: "Story A",
        author: "Alice",
        markdown: "Body A",
        publishedAt: "2026-01-01T00:00:00.000Z",
        metadata: {
          source: "rss",
          markdownSource: "content",
        },
      },
    });
    expect(candidates[1]).toMatchObject({
      url: "https://example.com/b",
      prefetchedArticle: {
        title: "Story B",
        markdown: "Description B only",
        metadata: {
          source: "rss",
          markdownSource: "description",
        },
      },
    });
    expect(candidates[2]).toMatchObject({
      url: "https://example.com/c",
      prefetchedArticle: undefined,
    });
  });

  it("supports RSS body-source overrides and stub fallback", async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <item>
            <title>Story A</title>
            <link>https://example.com/a</link>
            <description><![CDATA[Description A]]></description>
            <content:encoded><![CDATA[<p>Body A</p>]]></content:encoded>
          </item>
          <item>
            <title>Story B</title>
            <link>https://example.com/b</link>
            <description><![CDATA[Description B only]]></description>
          </item>
          <item>
            <title>Story C</title>
            <link>https://example.com/c</link>
            <description><![CDATA[   ]]></description>
          </item>
        </channel>
      </rss>`;

    global.fetch = jest.fn(async () => {
      const buffer = Buffer.from(rssXml, "utf8");
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "application/rss+xml" }),
        arrayBuffer: async () => buffer,
        text: async () => buffer.toString("utf8"),
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const candidates = await service.discoverRssCandidates({
      feedUrl: "https://example.com/feed.xml",
      maxUrls: 10,
      rssFetch: {
        bodySourceStrategy: "summary_only",
        noBodyPolicy: "title_description_stub",
      },
    });

    expect(candidates[0]).toMatchObject({
      url: "https://example.com/a",
      prefetchedArticle: {
        markdown: "Description A",
        metadata: {
          source: "rss",
          markdownSource: "description",
        },
      },
    });
    expect(candidates[1]).toMatchObject({
      url: "https://example.com/b",
      prefetchedArticle: {
        markdown: "Description B only",
        metadata: {
          source: "rss",
          markdownSource: "description",
        },
      },
    });
    expect(candidates[2]).toMatchObject({
      url: "https://example.com/c",
      prefetchedArticle: {
        markdown: "# Story C",
        metadata: {
          source: "rss",
          markdownSource: "stub",
        },
      },
    });
  });
});
