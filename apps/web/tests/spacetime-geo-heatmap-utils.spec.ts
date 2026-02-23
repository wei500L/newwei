import { describe, expect, it } from "vitest";

import {
  canLoadMoreArticles,
  inferBucketGranularityFromStarts,
  resolveArticleLimit,
  resolveBucketEndIso,
  resolveTooltipBucketEndIso,
  SPACETIME_GEO_ARTICLES_MAX_LIMIT,
  SPACETIME_GEO_ARTICLES_PAGE_SIZE,
} from "../app/(app)/dashboard/charts/spacetime-geo-heatmap-utils";

describe("spacetime geo heatmap utils", () => {
  it("resolves bucket end timestamps by granularity", () => {
    const start = "2026-01-01T00:00:00.000Z";
    expect(resolveBucketEndIso(start, "day")).toBe("2026-01-02T00:00:00.000Z");
    expect(resolveBucketEndIso(start, "week")).toBe("2026-01-08T00:00:00.000Z");
    expect(resolveBucketEndIso(start, "month")).toBe("2026-02-01T00:00:00.000Z");
    expect(resolveBucketEndIso(start, "auto")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("ignores explicit cursor bucket end when it mismatches expected granularity", () => {
    const value = resolveTooltipBucketEndIso({
      bucketStart: "2026-01-08T00:00:00.000Z",
      cursorBucketStartIso: "2026-01-08T00:00:00.000Z",
      cursorBucketEndIso: "2026-01-15T00:00:00.000Z",
      granularity: "day",
    });
    expect(value).toBe("2026-01-09T00:00:00.000Z");
  });

  it("uses explicit cursor bucket end when it matches expected granularity", () => {
    const value = resolveTooltipBucketEndIso({
      bucketStart: "2026-01-08T00:00:00.000Z",
      cursorBucketStartIso: "2026-01-08T00:00:00.000Z",
      cursorBucketEndIso: "2026-01-15T00:00:00.000Z",
      granularity: "week",
    });
    expect(value).toBe("2026-01-15T00:00:00.000Z");
  });

  it("falls back to granularity calculation when explicit end does not match", () => {
    const value = resolveTooltipBucketEndIso({
      bucketStart: "2026-01-08T00:00:00.000Z",
      cursorBucketStartIso: "2026-01-09T00:00:00.000Z",
      cursorBucketEndIso: "2026-01-15T00:00:00.000Z",
      granularity: "week",
    });
    expect(value).toBe("2026-01-15T00:00:00.000Z");
  });

  it("caps article limit and load-more availability", () => {
    expect(resolveArticleLimit(1)).toBe(SPACETIME_GEO_ARTICLES_PAGE_SIZE);
    expect(resolveArticleLimit(2)).toBe(SPACETIME_GEO_ARTICLES_PAGE_SIZE * 2);
    expect(resolveArticleLimit(99)).toBe(SPACETIME_GEO_ARTICLES_MAX_LIMIT);

    expect(canLoadMoreArticles(true, SPACETIME_GEO_ARTICLES_PAGE_SIZE)).toBe(true);
    expect(
      canLoadMoreArticles(true, SPACETIME_GEO_ARTICLES_MAX_LIMIT)
    ).toBe(false);
    expect(canLoadMoreArticles(false, SPACETIME_GEO_ARTICLES_PAGE_SIZE)).toBe(
      false
    );
  });

  it("infers day granularity when bucket evidence is insufficient", () => {
    expect(
      inferBucketGranularityFromStarts([
        "2026-01-01T00:00:00.000Z",
        "2026-01-08T00:00:00.000Z",
      ])
    ).toBe("day");
  });

  it("infers day granularity when daily cadence exists", () => {
    expect(
      inferBucketGranularityFromStarts([
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
        "2026-01-10T00:00:00.000Z",
      ])
    ).toBe("day");
  });

  it("infers weekly granularity from stable weekly starts", () => {
    expect(
      inferBucketGranularityFromStarts([
        "2026-01-01T00:00:00.000Z",
        "2026-01-08T00:00:00.000Z",
        "2026-01-15T00:00:00.000Z",
        "2026-01-22T00:00:00.000Z",
        "2026-01-29T00:00:00.000Z",
      ])
    ).toBe("week");
  });

  it("infers monthly granularity from stable monthly starts", () => {
    expect(
      inferBucketGranularityFromStarts([
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
      ])
    ).toBe("month");
  });
});
