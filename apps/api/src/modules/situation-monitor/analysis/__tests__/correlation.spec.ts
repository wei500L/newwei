import { analyzeCorrelations } from "../correlation";
import type { SituationNewsItem } from "../types";

describe("analyzeCorrelations (learning overrides)", () => {
  const makeItem = (options: { title: string; itemMetaId: string; source?: string }): SituationNewsItem => ({
    title: options.title,
    link: `https://example.com/${options.itemMetaId}`,
    source: options.source ?? "Substack",
    timestamp: 1700000000000,
    itemMetaId: options.itemMetaId,
  });

  it("supports boosted tokens, blocked tokens, and per-item suppression", () => {
    const items: SituationNewsItem[] = [
      makeItem({ title: "Midterms update", itemMetaId: "m1" }),
      makeItem({ title: "Midterms analysis", itemMetaId: "m2" }),
      makeItem({ title: "Midterms coverage", itemMetaId: "m3" }),
    ];

    const boosted = new Map([
      [
        "election",
        {
          boostedTokens: ["midterms"],
          falseNegativeCount: 1,
        },
      ],
    ]);

    const boostedResult = analyzeCorrelations(items, { learning: boosted });
    expect(boostedResult.topicCounts.election ?? 0).toBe(3);
    expect(boostedResult.results?.emergingPatterns.find((entry) => entry.id === "election")?.learning?.boostedTokens).toContain(
      "midterms",
    );

    const blocked = new Map([
      [
        "election",
        {
          boostedTokens: ["midterms"],
          blockedTokens: ["midterms"],
        },
      ],
    ]);

    const blockedResult = analyzeCorrelations(items, { learning: blocked });
    expect(blockedResult.topicCounts.election ?? 0).toBe(0);

    const suppressed = new Map([
      [
        "election",
        {
          boostedTokens: ["midterms"],
          suppressedItemMetaIds: ["m1"],
        },
      ],
    ]);

    const suppressedResult = analyzeCorrelations(items, { learning: suppressed });
    expect(suppressedResult.topicCounts.election ?? 0).toBe(2);
    expect(suppressedResult.results?.emergingPatterns.find((entry) => entry.id === "election")).toBeUndefined();
  });
});

