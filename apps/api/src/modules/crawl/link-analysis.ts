import {
  CrawlLinkAnalysis,
  CrawlLinkAnalysisBucket,
  CrawlLinkAnalysisLink,
  CrawlLinkAnalysisStats
} from "./crawl.types";

type Crawl4aiLinkBuckets = Record<string, unknown>;

const HIGH_QUALITY_THRESHOLD = 7;
const LOW_QUALITY_THRESHOLD = 3;

export function buildLinkAnalysis(source?: unknown): CrawlLinkAnalysis | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const record = source as Crawl4aiLinkBuckets;
  const buckets: CrawlLinkAnalysisBucket[] = [];
  const allLinks: CrawlLinkAnalysisLink[] = [];
  let internalCount = 0;
  let externalCount = 0;

  for (const [kind, value] of Object.entries(record)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const normalized = value
      .map((entry) => normalizeLink(entry, kind))
      .filter((link): link is CrawlLinkAnalysisLink => Boolean(link));
    if (normalized.length === 0) {
      continue;
    }
    buckets.push({ kind, links: normalized });
    allLinks.push(...normalized);
    if (kind === "internal") {
      internalCount += normalized.length;
    }
    if (kind === "external") {
      externalCount += normalized.length;
    }
  }

  if (allLinks.length === 0) {
    return undefined;
  }

  const stats = buildStats(allLinks, internalCount, externalCount);
  const topLinks = pickTopLinks(allLinks);
  const lowQualityLinks = pickLowQualityLinks(allLinks);

  return {
    stats,
    buckets,
    topLinks,
    lowQualityLinks
  };
}

function buildStats(
  links: CrawlLinkAnalysisLink[],
  internalCount: number,
  externalCount: number
): CrawlLinkAnalysisStats {
  const intrinsicScores = links
    .map((link) => link.intrinsicScore)
    .filter((score): score is number => typeof score === "number");
  const averageIntrinsicScore =
    intrinsicScores.length > 0
      ? Number((intrinsicScores.reduce((acc, value) => acc + value, 0) / intrinsicScores.length).toFixed(2))
      : undefined;
  const highQualityLinks = links.filter((link) => (link.intrinsicScore ?? 0) >= HIGH_QUALITY_THRESHOLD).length;
  const lowQualityLinks = links.filter((link) => (link.intrinsicScore ?? 0) > 0 && (link.intrinsicScore ?? 0) < LOW_QUALITY_THRESHOLD)
    .length;
  return {
    totalLinks: links.length,
    internalLinks: internalCount,
    externalLinks: externalCount,
    averageIntrinsicScore,
    highQualityLinks,
    lowQualityLinks
  };
}

function pickTopLinks(links: CrawlLinkAnalysisLink[]) {
  return [...links]
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 5);
}

function pickLowQualityLinks(links: CrawlLinkAnalysisLink[]) {
  return [...links]
    .sort((a, b) => (a.intrinsicScore ?? Number.POSITIVE_INFINITY) - (b.intrinsicScore ?? Number.POSITIVE_INFINITY))
    .slice(0, 5);
}

function scoreOf(link: CrawlLinkAnalysisLink) {
  if (typeof link.totalScore === "number") {
    return link.totalScore;
  }
  if (typeof link.contextualScore === "number") {
    return link.contextualScore;
  }
  if (typeof link.intrinsicScore === "number") {
    return link.intrinsicScore;
  }
  return 0;
}

function normalizeLink(entry: unknown, kind: string): CrawlLinkAnalysisLink | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const href = pickString(record, ["href", "url"]);
  if (!href) {
    return undefined;
  }
  return {
    href,
    text: pickString(record, ["text", "label", "content"]),
    title: pickString(record, ["title"]),
    baseDomain: pickString(record, ["base_domain", "baseDomain"]),
    rel: pickString(record, ["rel"]),
    type: kind,
    intrinsicScore: pickNumber(record, ["intrinsic_score", "intrinsicScore", "score"]),
    contextualScore: pickNumber(record, ["contextual_score", "contextualScore"]),
    totalScore: pickNumber(record, ["total_score", "totalScore"])
  };
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && !Number.isNaN(value)) {
      return value;
    }
  }
  return undefined;
}
