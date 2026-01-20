import { analyzeNarratives } from "../narrative";
import type { SituationNewsItem } from "../types";

describe("analyzeNarratives", () => {
  it("adds propagation model fields and applies learning overrides", () => {
    const base: SituationNewsItem[] = [
      {
        title: "Election fraud claims debunked by officials",
        link: "https://example.com/a",
        source: "Reuters",
        timestamp: 1700000000000,
        itemMetaId: "meta-a",
      },
      {
        title: "Permanent bureaucracy exposed",
        link: "https://example.com/b",
        source: "Substack",
        timestamp: 1700000001000,
        itemMetaId: "meta-b",
      },
      {
        title: "Rigged election allegations spread on Telegram",
        link: "https://example.com/c",
        source: "Telegram",
        timestamp: 1700000002000,
        itemMetaId: "meta-c",
      },
    ];

    const learning = new Map([
      [
        "election-fraud",
        {
          blockedTokens: ["debunked"],
          suppressedItemMetaIds: ["meta-c"],
          falsePositiveCount: 3,
        },
      ],
      [
        "deep-state",
        {
          boostedTokens: ["bureaucracy"],
          falseNegativeCount: 1,
        },
      ],
    ]);

    const result = analyzeNarratives(base, { learning });
    expect(result).toBeTruthy();

    const deepState = [...(result?.emergingFringe ?? []), ...(result?.narrativeWatch ?? [])].find(
      (entry) => entry.id === "deep-state",
    );
    expect(deepState).toBeTruthy();
    expect(deepState?.alternativeCount).toBeGreaterThan(0);
    expect(deepState?.model?.crossSourceRadar).toBeTruthy();
    expect(deepState?.model?.fringeToMainstreamPath).toBeTruthy();
    expect(deepState?.model?.credibility?.score).toBeGreaterThanOrEqual(0);
    expect(deepState?.model?.citationChain).toBeTruthy();

    const electionFraud = [...(result?.emergingFringe ?? []), ...(result?.narrativeWatch ?? [])].find(
      (entry) => entry.id === "election-fraud",
    );
    expect(electionFraud).toBeFalsy();
  });
});

