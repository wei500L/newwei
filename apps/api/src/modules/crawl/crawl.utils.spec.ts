import { clampResultLimit, coerceDate, hashMarkdown, normalizeKeywords } from "./crawl.utils";

describe("Crawl utils", () => {
  it("normalizes and dedupes keywords", () => {
    expect(normalizeKeywords(["AI", "  ai ", "Security", ""])).toEqual(["ai", "security"]);
  });

  it("limits keyword list to 25 entries", () => {
    const raw = Array.from({ length: 30 }, (_, idx) => `k${idx}`);
    expect(normalizeKeywords(raw)).toHaveLength(25);
  });

  it("clamps result limit", () => {
    expect(clampResultLimit(0)).toBe(1);
    expect(clampResultLimit(500)).toBe(100);
    expect(clampResultLimit(undefined, 15)).toBe(15);
  });

  it("hashes markdown content deterministically", () => {
    const hashA = hashMarkdown("# hello");
    const hashB = hashMarkdown("# hello");
    const hashC = hashMarkdown("# goodbye");
    expect(hashA).toEqual(hashB);
    expect(hashA).not.toEqual(hashC);
  });

  it("coerces valid ISO date strings", () => {
    const result = coerceDate("2024-01-01T00:00:00.000Z");
    expect(result?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns undefined for invalid dates", () => {
    expect(coerceDate("not-a-date")).toBeUndefined();
  });
});
