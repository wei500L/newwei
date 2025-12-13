jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
  };
});

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

