/**
 * Crawl Task Detail 链接总览模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：跨结果聚合 linkAnalysis（总数/内外链/高低质量/加权均值、
 * href 去重排序、bucket 合并），保持既有排序与 fallback 语义。
 */

import type { CrawlTaskDetailResult } from "./task-detail-types";

interface LinkScoreFields {
  totalScore?: number | null;
  contextualScore?: number | null;
  intrinsicScore?: number | null;
}

type ScoredLink = NonNullable<
  NonNullable<CrawlTaskDetailResult["linkAnalysis"]>["topLinks"]
>[number];

export function getLinkScore(link: LinkScoreFields): number {
  return link.totalScore ?? link.contextualScore ?? link.intrinsicScore ?? 0;
}

interface CrawlLinkOverview {
  stats: {
    totalLinks: number;
    internalLinks: number;
    externalLinks: number;
    highQualityLinks: number;
    lowQualityLinks: number;
    averageIntrinsic: number | null;
  };
  topLinks: ScoredLink[];
  lowLinks: NonNullable<
    NonNullable<CrawlTaskDetailResult["linkAnalysis"]>["lowQualityLinks"]
  >;
  buckets: {
    kind: string;
    count: number;
    samples: ScoredLink[];
  }[];
}

export function buildLinkOverview(
  results: readonly CrawlTaskDetailResult[] | null | undefined,
): CrawlLinkOverview | null {
  const analyses =
    results
      ?.map((result) => result.linkAnalysis)
      .filter((analysis): analysis is NonNullable<typeof analysis> =>
        Boolean(analysis),
      ) ?? [];
  if (!analyses.length) {
    return null;
  }
  const totalLinks = analyses.reduce(
    (sum, analysis) => sum + analysis.stats.totalLinks,
    0,
  );
  const internalLinks = analyses.reduce(
    (sum, analysis) => sum + analysis.stats.internalLinks,
    0,
  );
  const externalLinks = analyses.reduce(
    (sum, analysis) => sum + analysis.stats.externalLinks,
    0,
  );
  const highQualityLinks = analyses.reduce(
    (sum, analysis) => sum + (analysis.stats.highQualityLinks ?? 0),
    0,
  );
  const lowQualityLinks = analyses.reduce(
    (sum, analysis) => sum + (analysis.stats.lowQualityLinks ?? 0),
    0,
  );
  const weightedIntrinsic = analyses.reduce((sum, analysis) => {
    const avg = analysis.stats.averageIntrinsicScore ?? 0;
    return sum + avg * analysis.stats.totalLinks;
  }, 0);
  const averageIntrinsic =
    totalLinks > 0
      ? Number((weightedIntrinsic / totalLinks).toFixed(2))
      : null;
  const aggregateLinks = <T,>(items: T[]) => {
    const seen = new Set<string>();
    const ordered: T[] = [];
    for (const item of items) {
      const link = item as { href?: string };
      const key = link.href ?? JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(item);
      }
    }
    return ordered;
  };
  const topLinks = aggregateLinks(
    analyses.flatMap((analysis) => analysis.topLinks ?? []),
  )
    .sort((a, b) => getLinkScore(b) - getLinkScore(a))
    .slice(0, 5);
  const lowLinks = aggregateLinks(
    analyses.flatMap((analysis) => analysis.lowQualityLinks ?? []),
  )
    .sort(
      (a, b) =>
        (a.intrinsicScore ?? Number.POSITIVE_INFINITY) -
        (b.intrinsicScore ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, 5);
  const bucketMap = new Map<
    string,
    {
      count: number;
      links: NonNullable<(typeof analyses)[number]["topLinks"]>;
    }
  >();
  analyses.forEach((analysis) => {
    analysis.buckets.forEach((bucket) => {
      const existing = bucketMap.get(bucket.kind);
      if (existing) {
        existing.count += bucket.links.length;
        existing.links.push(...bucket.links);
      } else {
        bucketMap.set(bucket.kind, {
          count: bucket.links.length,
          links: [...bucket.links],
        });
      }
    });
  });
  const buckets = Array.from(bucketMap.entries()).map(([kind, value]) => ({
    kind,
    count: value.count,
    samples: value.links.slice(0, 4),
  }));
  return {
    stats: {
      totalLinks,
      internalLinks,
      externalLinks,
      highQualityLinks,
      lowQualityLinks,
      averageIntrinsic,
    },
    topLinks,
    lowLinks,
    buckets,
  };
}
