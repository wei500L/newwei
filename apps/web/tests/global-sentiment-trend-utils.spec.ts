import { describe, expect, it } from "vitest";

import {
  prepareGlobalSentimentTrendSeries,
  resolveSentimentSeriesKey,
} from "../app/(app)/dashboard/components/global-sentiment-trend-utils";

describe("global sentiment trend utils", () => {
  it("resolves sentiment series key from sourceField, slug, or display name", () => {
    expect(
      resolveSentimentSeriesKey({
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 1,
        sourceField: "positive_ratio",
      })
    ).toBe("positive");

    expect(
      resolveSentimentSeriesKey({
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 1,
        item: { slug: "negative_index" },
      })
    ).toBe("negative");

    expect(
      resolveSentimentSeriesKey({
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 1,
        item: { displayName: "Neutral sentiment" },
      })
    ).toBe("neutral");
  });

  it("builds split series when sentiment dimensions are recognizable", () => {
    const prepared = prepareGlobalSentimentTrendSeries([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 10,
        sourceField: "positive_ratio",
      },
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 4,
        sourceField: "negative_ratio",
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        value: 6,
        sourceField: "neutral_ratio",
      },
    ]);

    expect(prepared.mode).toBe("split");
    if (prepared.mode !== "split") return;
    expect(prepared.timestamps).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(prepared.positiveValues).toEqual([10, 0]);
    expect(prepared.neutralValues).toEqual([0, 6]);
    expect(prepared.negativeValues).toEqual([4, 0]);
  });

  it("falls back to aggregate series when sentiment dimensions are unknown", () => {
    const prepared = prepareGlobalSentimentTrendSeries([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 3,
        sourceField: "usdx",
      },
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 2,
        item: { slug: "sp500" },
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        value: 5,
        item: { displayName: "Market sentiment proxy" },
      },
    ]);

    expect(prepared.mode).toBe("aggregate");
    if (prepared.mode !== "aggregate") return;
    expect(prepared.timestamps).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(prepared.aggregateValues).toEqual([5, 5]);
  });
});
