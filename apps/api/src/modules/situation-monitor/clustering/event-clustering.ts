import {
  SITUATION_MONITOR_CATEGORIES,
  type SituationMonitorCategory,
} from "../situation-monitor.constants";
import type {
  SituationMonitorEventCluster,
  SituationMonitorHeadline,
} from "../situation-monitor.types";

const CLUSTER_TITLE_SIMILARITY_THRESHOLD = 0.74;
const CLUSTER_MAX_TIME_DIFF_MS = 36 * 60 * 60 * 1000;
const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
const TRAILING_SOURCE_SUFFIXES = [
  "reuters",
  "associated press",
  "ap",
  "afp",
  "bbc",
  "cnn",
  "fox news",
  "the guardian",
  "bloomberg",
  "financial times",
  "new york times",
  "washington post",
];
const TRACKING_QUERY_PARAMS = [
  "cmpid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_source",
  "utm_term",
];

export interface SituationMonitorClusterBuildOptions {
  maxClustersPerCategory?: number;
  maxItemsPerCluster?: number;
}

export interface SituationMonitorCategoryClusterMetrics {
  clusterCount: number;
  mixedSourceClusterCount: number;
  distinctSourceCount: number;
}

export interface SituationMonitorClusterQualitySummary {
  articleCount: number;
  clusterCount: number;
  mixedSourceClusterCount: number;
  dedupeRatio: number | null;
  avgSourcesPerCluster: number | null;
}

interface ClusterAccumulator {
  category: SituationMonitorCategory;
  items: SituationMonitorHeadline[];
  canonicalUrls: Set<string>;
  normalizedTitles: Set<string>;
  duplicateKeys: Set<string>;
  sourceKeys: Set<string>;
  latestTimestamp: number;
  hasInternal: boolean;
  hasExternal: boolean;
  isAlert: boolean;
}

export function buildSituationMonitorEventClusters(
  headlinesByCategory: Record<SituationMonitorCategory, SituationMonitorHeadline[]>,
  options?: SituationMonitorClusterBuildOptions,
): Record<SituationMonitorCategory, SituationMonitorEventCluster[]> {
  const maxClustersPerCategory = clampInt(
    options?.maxClustersPerCategory,
    1,
    200,
    6,
  );
  const maxItemsPerCluster = clampInt(options?.maxItemsPerCluster, 1, 100, 6);

  return Object.fromEntries(
    SITUATION_MONITOR_CATEGORIES.map((category) => {
      const clusters = buildCategoryClusters(headlinesByCategory[category] ?? [])
        .slice(0, maxClustersPerCategory)
        .map((cluster) => trimClusterItems(cluster, maxItemsPerCluster));
      return [category, clusters];
    }),
  ) as Record<SituationMonitorCategory, SituationMonitorEventCluster[]>;
}

export function summarizeSituationMonitorCategoryClusters(
  headlines: SituationMonitorHeadline[],
  clusters: SituationMonitorEventCluster[],
): SituationMonitorCategoryClusterMetrics {
  return {
    clusterCount: clusters.length,
    mixedSourceClusterCount: clusters.filter((cluster) => cluster.mixedSource)
      .length,
    distinctSourceCount: new Set(
      headlines
        .map((headline) => normalizeSourceKey(headline.source))
        .filter(Boolean),
    ).size,
  };
}

export function summarizeSituationMonitorClusterQuality(options: {
  headlinesByCategory: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  clustersByCategory: Record<SituationMonitorCategory, SituationMonitorEventCluster[]>;
}): SituationMonitorClusterQualitySummary {
  const articleCount = SITUATION_MONITOR_CATEGORIES.reduce(
    (sum, category) => sum + (options.headlinesByCategory[category] ?? []).length,
    0,
  );
  const clusters = SITUATION_MONITOR_CATEGORIES.flatMap(
    (category) => options.clustersByCategory[category] ?? [],
  );
  const clusterCount = clusters.length;
  const mixedSourceClusterCount = clusters.filter((cluster) => cluster.mixedSource)
    .length;
  const avgSourcesPerCluster =
    clusterCount > 0
      ? roundToSingleDecimal(
          clusters.reduce(
            (sum, cluster) => sum + cluster.distinctSourceCount,
            0,
          ) / clusterCount,
        )
      : null;

  return {
    articleCount,
    clusterCount,
    mixedSourceClusterCount,
    dedupeRatio:
      articleCount > 0
        ? roundToSingleDecimal((articleCount - clusterCount) / articleCount)
        : null,
    avgSourcesPerCluster,
  };
}

function buildCategoryClusters(
  headlines: SituationMonitorHeadline[],
): SituationMonitorEventCluster[] {
  const accumulators: ClusterAccumulator[] = [];
  const ordered = [...headlines].sort((a, b) => b.timestamp - a.timestamp);

  for (const headline of ordered) {
    const matched = accumulators.find((cluster) =>
      matchesCluster(cluster, headline),
    );
    if (matched) {
      appendHeadline(matched, headline);
      continue;
    }
    accumulators.push(createClusterAccumulator(headline));
  }

  return accumulators
    .map(materializeCluster)
    .sort(compareClusters);
}

function trimClusterItems(
  cluster: SituationMonitorEventCluster,
  maxItemsPerCluster: number,
): SituationMonitorEventCluster {
  const trimmedItems = cluster.items.slice(0, maxItemsPerCluster);
  const lead =
    trimmedItems.find((item) => item.id === cluster.lead.id) ?? trimmedItems[0] ?? cluster.lead;
  return {
    ...cluster,
    lead,
    items: trimmedItems,
  };
}

function createClusterAccumulator(
  headline: SituationMonitorHeadline,
): ClusterAccumulator {
  return {
    category: headline.category,
    items: [headline],
    canonicalUrls: new Set([canonicalizeUrl(headline.link)].filter(Boolean)),
    normalizedTitles: new Set([normalizeTitle(headline.title)].filter(Boolean)),
    duplicateKeys: new Set(getHeadlineDuplicateKeys(headline)),
    sourceKeys: new Set([normalizeSourceKey(headline.source)].filter(Boolean)),
    latestTimestamp: headline.timestamp,
    hasInternal: headline.origin === "items",
    hasExternal: headline.origin === "gdelt",
    isAlert: headline.isAlert,
  };
}

function appendHeadline(
  cluster: ClusterAccumulator,
  headline: SituationMonitorHeadline,
) {
  cluster.items.push(headline);
  const canonicalUrl = canonicalizeUrl(headline.link);
  if (canonicalUrl) {
    cluster.canonicalUrls.add(canonicalUrl);
  }
  const normalizedTitle = normalizeTitle(headline.title);
  if (normalizedTitle) {
    cluster.normalizedTitles.add(normalizedTitle);
  }
  for (const duplicateKey of getHeadlineDuplicateKeys(headline)) {
    cluster.duplicateKeys.add(duplicateKey);
  }
  const sourceKey = normalizeSourceKey(headline.source);
  if (sourceKey) {
    cluster.sourceKeys.add(sourceKey);
  }
  cluster.latestTimestamp = Math.max(cluster.latestTimestamp, headline.timestamp);
  cluster.hasInternal = cluster.hasInternal || headline.origin === "items";
  cluster.hasExternal = cluster.hasExternal || headline.origin === "gdelt";
  cluster.isAlert = cluster.isAlert || headline.isAlert;
}

function matchesCluster(
  cluster: ClusterAccumulator,
  headline: SituationMonitorHeadline,
): boolean {
  if (cluster.category !== headline.category) {
    return false;
  }

  const canonicalUrl = canonicalizeUrl(headline.link);
  if (canonicalUrl && cluster.canonicalUrls.has(canonicalUrl)) {
    return true;
  }

  const duplicateKeys = getHeadlineDuplicateKeys(headline);
  if (
    duplicateKeys.some((duplicateKey) => cluster.duplicateKeys.has(duplicateKey))
  ) {
    return true;
  }

  const normalizedTitle = normalizeTitle(headline.title);
  if (!normalizedTitle) {
    return false;
  }
  if (cluster.normalizedTitles.has(normalizedTitle)) {
    return true;
  }

  const titleTokens = tokenizeTitle(normalizedTitle);
  if (titleTokens.size < 4) {
    return false;
  }

  return cluster.items.some((candidate) => {
    if (
      Math.abs(
        Math.max(cluster.latestTimestamp, candidate.timestamp) - headline.timestamp,
      ) > CLUSTER_MAX_TIME_DIFF_MS
    ) {
      return false;
    }

    const candidateTitle = normalizeTitle(candidate.title);
    if (!candidateTitle) {
      return false;
    }
    const candidateTokens = tokenizeTitle(candidateTitle);
    if (candidateTokens.size < 4) {
      return false;
    }

    return (
      jaccardSimilarity(titleTokens, candidateTokens) >=
      CLUSTER_TITLE_SIMILARITY_THRESHOLD
    );
  });
}

function materializeCluster(
  cluster: ClusterAccumulator,
): SituationMonitorEventCluster {
  const items = [...cluster.items].sort((a, b) => b.timestamp - a.timestamp);
  const lead = selectClusterLead(items, cluster.hasInternal && cluster.hasExternal);
  return {
    id: buildClusterId(cluster.category, lead),
    category: cluster.category,
    lead,
    items,
    internalCount: items.filter((item) => item.origin === "items").length,
    externalCount: items.filter((item) => item.origin === "gdelt").length,
    distinctSourceCount: cluster.sourceKeys.size,
    latestTimestamp: cluster.latestTimestamp,
    isAlert: cluster.isAlert,
    mixedSource: cluster.hasInternal && cluster.hasExternal,
  };
}

function selectClusterLead(
  items: SituationMonitorHeadline[],
  mixedSource: boolean,
): SituationMonitorHeadline {
  const [lead] = [...items].sort((left, right) => {
    if (left.isAlert !== right.isAlert) {
      return left.isAlert ? -1 : 1;
    }
    const leftHasSummary = Boolean(left.summary?.trim());
    const rightHasSummary = Boolean(right.summary?.trim());
    if (leftHasSummary !== rightHasSummary) {
      return leftHasSummary ? -1 : 1;
    }
    if (mixedSource && left.origin !== right.origin) {
      return left.origin === "items" ? -1 : 1;
    }
    if (left.timestamp !== right.timestamp) {
      return right.timestamp - left.timestamp;
    }
    return left.id.localeCompare(right.id);
  });

  if (!lead) {
    throw new Error(
      "Situation Monitor cluster lead selection requires at least one item",
    );
  }

  return lead;
}

function compareClusters(
  left: SituationMonitorEventCluster,
  right: SituationMonitorEventCluster,
): number {
  if (left.isAlert !== right.isAlert) {
    return left.isAlert ? -1 : 1;
  }
  if (left.mixedSource !== right.mixedSource) {
    return left.mixedSource ? -1 : 1;
  }
  if (left.distinctSourceCount !== right.distinctSourceCount) {
    return right.distinctSourceCount - left.distinctSourceCount;
  }
  if (left.latestTimestamp !== right.latestTimestamp) {
    return right.latestTimestamp - left.latestTimestamp;
  }
  if (left.internalCount !== right.internalCount) {
    return right.internalCount - left.internalCount;
  }
  return left.id.localeCompare(right.id);
}

function buildClusterId(
  category: SituationMonitorCategory,
  lead: SituationMonitorHeadline,
): string {
  const canonicalUrl = canonicalizeUrl(lead.link);
  if (canonicalUrl) {
    return `${category}:${canonicalUrl}`;
  }
  const normalizedTitle = normalizeTitle(lead.title);
  if (normalizedTitle) {
    return `${category}:${normalizedTitle.replace(/\s+/g, "-")}`;
  }
  return `${category}:${lead.id}`;
}

function getHeadlineDuplicateKeys(headline: SituationMonitorHeadline): string[] {
  return [headline.duplicateOf, headline.id, headline.itemMetaId]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function canonicalizeUrl(input: string): string {
  const normalizedInput = typeof input === "string" ? input.trim() : "";
  if (!normalizedInput) {
    return "";
  }
  try {
    const url = new URL(normalizedInput);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const param of TRACKING_QUERY_PARAMS) {
      url.searchParams.delete(param);
    }
    const entries = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    url.search = "";
    for (const [key, value] of entries) {
      url.searchParams.append(key, value);
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.hostname}${pathname}${url.search}`;
  } catch {
    return normalizedInput.toLowerCase();
  }
}

function normalizeTitle(input: string): string {
  const normalizedInput = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!normalizedInput) {
    return "";
  }

  let next = normalizedInput;
  for (const suffix of TRAILING_SOURCE_SUFFIXES) {
    next = next.replace(new RegExp(`\\s+[\\-|:]\\s+${escapeRegex(suffix)}$`, "i"), "");
    next = next.replace(new RegExp(`\\s+\\|\\s+${escapeRegex(suffix)}$`, "i"), "");
  }

  return next.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeTitle(normalizedTitle: string): Set<string> {
  return new Set(
    normalizedTitle
      .split(" ")
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length > 1 && !TITLE_STOP_WORDS.has(token),
      ),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

function normalizeSourceKey(source: string): string {
  return typeof source === "string" ? source.trim().toLowerCase() : "";
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
