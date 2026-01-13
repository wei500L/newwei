jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

import { gzipSync } from "node:zlib";

import { CrawlMetadataService } from "../crawl-metadata.service";

describe("CrawlMetadataService pattern matching", () => {
  const normalizePattern = (service: CrawlMetadataService, pattern?: string) =>
    (service as any).normalizePattern(pattern) as undefined | ((url: string) => boolean);

  it("returns undefined for empty patterns", () => {
    const service = new CrawlMetadataService();
    expect(normalizePattern(service, undefined)).toBeUndefined();
    expect(normalizePattern(service, "")).toBeUndefined();
    expect(normalizePattern(service, "   ")).toBeUndefined();
  });

  it("matches full url with '*' and '?' wildcards (case-insensitive)", () => {
    const service = new CrawlMetadataService();
    const matcher = normalizePattern(service, "HTTPS://Example.com/path/*/it?m");

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

  afterEach(() => {
    global.fetch = originalFetch;
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
      const makeHeaders = (headers: Record<string, string>) => ({
        get: (key: string) => headers[key.toLowerCase()] ?? null
      });

      if (url === "https://example.com/sitemap.xml") {
        const buffer = Buffer.from(sitemapIndexXml, "utf8");
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/xml" }),
          arrayBuffer: async () => buffer,
          text: async () => buffer.toString("utf8")
        } as any;
      }

      if (url === "https://example.com/sitemap-posts.xml.gz") {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({ "content-type": "application/x-gzip" }),
          arrayBuffer: async () => gzipped,
          text: async () => gzipped.toString("utf8")
        } as any;
      }

      return {
        ok: false,
        status: 404,
        headers: makeHeaders({}),
        arrayBuffer: async () => Buffer.from("", "utf8"),
        text: async () => ""
      } as any;
    }) as any;

    const service = new CrawlMetadataService();
    const urls = await service.discoverSitemapUrls({
      domain: "https://example.com",
      pattern: "https://example.com/a/*",
      maxUrls: 10,
      requestTimeoutMs: 5000
    });

    expect(urls).toEqual(["https://example.com/a/1"]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/sitemap-posts.xml.gz",
      expect.any(Object)
    );
  });
});
