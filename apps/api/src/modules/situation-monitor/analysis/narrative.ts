import { NARRATIVE_PATTERNS, SOURCE_TYPES, type NarrativePattern } from "./patterns";
import type { SituationNewsItem } from "./types";

export interface NarrativeLearningOverride {
  boostedTokens?: string[];
  blockedTokens?: string[];
  suppressedItemMetaIds?: string[];
  falsePositiveCount?: number;
  falseNegativeCount?: number;
}

export interface CrossSourceRadarCluster {
  id: string;
  itemCount: number;
  sources: string[];
  samples: SituationNewsItem[];
}

export interface CrossSourceRadar {
  consistency: number;
  divergence: number;
  clusterCount: number;
  clusters: CrossSourceRadarCluster[];
  outlierSources: string[];
}

export interface FringeMainstreamPathStep {
  tier: "fringe" | "alternative" | "mainstream" | "unknown";
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  sources: string[];
}

export interface FringeMainstreamPath {
  steps: FringeMainstreamPathStep[];
  lagToMainstreamMs?: number;
}

export interface CitationLink {
  from: string;
  to: string;
  weight: number;
}

export interface CitationChain {
  nodes: string[];
  links: CitationLink[];
  topCited: Array<{ source: string; weight: number }>;
  citedByCount: number;
}

export interface CredibilityAssessment {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
  components: {
    sourceReliability: number;
    corroboration: number;
    citationSupport: number;
    divergence: number;
    feedbackPenalty: number;
  };
}

export interface NarrativePropagationModel {
  crossSourceRadar: CrossSourceRadar;
  fringeToMainstreamPath: FringeMainstreamPath;
  credibility: CredibilityAssessment;
  citationChain: CitationChain;
}

export interface NarrativeData {
  id: string;
  name: string;
  category: string;
  severity: NarrativePattern["severity"];
  count: number;
  fringeCount: number;
  alternativeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: SituationNewsItem[];
  keywords: string[];
  feedback?: { falsePositive: number; falseNegative: number };
  model?: NarrativePropagationModel;
  learning?: { boostedTokens: string[]; blockedTokens: string[]; suppressedCount: number };
}

export interface EmergingFringe extends NarrativeData {
  status: "emerging" | "spreading" | "viral";
}

export interface FringeToMainstream extends NarrativeData {
  status: "crossing";
  crossoverLevel: number;
}

export interface NarrativeResults {
  emergingFringe: EmergingFringe[];
  fringeToMainstream: FringeToMainstream[];
  narrativeWatch: NarrativeData[];
  disinfoSignals: NarrativeData[];
}

function formatNarrativeName(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function classifySource(source: string): "fringe" | "alternative" | "mainstream" | null {
  const lowerSource = source.toLowerCase();

  for (const fringeSource of SOURCE_TYPES.fringe) {
    if (lowerSource.includes(fringeSource)) return "fringe";
  }
  for (const altSource of SOURCE_TYPES.alternative) {
    if (lowerSource.includes(altSource)) return "alternative";
  }
  for (const msSource of SOURCE_TYPES.mainstream) {
    if (lowerSource.includes(msSource)) return "mainstream";
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeForMatch(item: SituationNewsItem): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  if (item.summary) parts.push(item.summary);
  if (Array.isArray(item.keyPoints) && item.keyPoints.length > 0) {
    parts.push(item.keyPoints.join(" "));
  }
  return parts.join(" ").toLowerCase();
}

const NARRATIVE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function tokenize(text: string): Set<string> {
  const result = new Set<string>();
  const ascii = text.match(/[a-z0-9]{3,24}/g) ?? [];
  for (const token of ascii) {
    if (NARRATIVE_STOPWORDS.has(token)) {
      continue;
    }
    result.add(token);
    if (result.size >= 80) {
      break;
    }
  }

  const cjk = text.match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  for (const token of cjk) {
    result.add(token);
    if (result.size >= 120) {
      break;
    }
  }

  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function buildCrossSourceRadar(matches: SituationNewsItem[]): CrossSourceRadar {
  const maxItems = 80;
  const items = matches
    .slice()
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, maxItems);

  type Cluster = {
    id: string;
    repTokens: Set<string>;
    items: SituationNewsItem[];
    sources: Set<string>;
  };

  const clusters: Cluster[] = [];
  const sourceSet = new Set<string>();

  for (const item of items) {
    const text = normalizeForMatch(item);
    const tokens = tokenize(text);
    sourceSet.add(item.source);

    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const cluster = clusters[i];
      if (!cluster) {
        continue;
      }
      const score = jaccard(tokens, cluster.repTokens);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const threshold = 0.35;
    const bestCluster = bestIndex !== -1 ? clusters[bestIndex] : undefined;
    if (bestCluster && bestScore >= threshold) {
      bestCluster.items.push(item);
      bestCluster.sources.add(item.source);
      continue;
    }

    const id = `c${clusters.length + 1}`;
    clusters.push({ id, repTokens: tokens, items: [item], sources: new Set([item.source]) });
  }

  if (clusters.length === 0) {
    return { consistency: 0, divergence: 0, clusterCount: 0, clusters: [], outlierSources: [] };
  }

  const totalItems = clusters.reduce((sum, cluster) => sum + cluster.items.length, 0);
  const totalSources = sourceSet.size;

  const counts = clusters.map((cluster) => cluster.items.length / Math.max(1, totalItems));
  let entropy = 0;
  for (const p of counts) {
    if (p > 0) {
      entropy -= p * Math.log(p);
    }
  }
  const divergence = clusters.length <= 1 ? 0 : clamp01(entropy / Math.log(clusters.length));

  const main = clusters
    .slice()
    .sort((a, b) => b.sources.size - a.sources.size || b.items.length - a.items.length)[0];
  if (!main) {
    return { consistency: 0, divergence, clusterCount: clusters.length, clusters: [], outlierSources: [] };
  }
  const mainCoverage = totalSources > 0 ? main.sources.size / totalSources : 0;
  const consistency = clamp01(mainCoverage * (1 - divergence));

  const outliers =
    totalSources === 0
      ? []
      : Array.from(sourceSet).filter((source) => !main.sources.has(source)).slice(0, 6);

  clusters.sort((a, b) => b.items.length - a.items.length);
  const summarized: CrossSourceRadarCluster[] = clusters.slice(0, 4).map((cluster) => ({
    id: cluster.id,
    itemCount: cluster.items.length,
    sources: Array.from(cluster.sources).slice(0, 8),
    samples: cluster.items.slice(0, 2),
  }));

  return {
    consistency,
    divergence,
    clusterCount: clusters.length,
    clusters: summarized,
    outlierSources: outliers,
  };
}

function buildFringeMainstreamPath(matches: SituationNewsItem[]): FringeMainstreamPath {
  const buckets: Record<FringeMainstreamPathStep["tier"], SituationNewsItem[]> = {
    fringe: [],
    alternative: [],
    mainstream: [],
    unknown: [],
  };

  for (const item of matches) {
    const tier = classifySource(item.source ?? "") ?? "unknown";
    buckets[tier].push(item);
  }

  const order: FringeMainstreamPathStep["tier"][] = ["fringe", "alternative", "mainstream", "unknown"];
  const steps: FringeMainstreamPathStep[] = [];
  for (const tier of order) {
    const items = buckets[tier];
    if (!items || items.length === 0) {
      continue;
    }
    const timestamps = items.map((item) => item.timestamp).filter((t) => Number.isFinite(t));
    const firstSeenAt = timestamps.length ? Math.min(...timestamps) : 0;
    const lastSeenAt = timestamps.length ? Math.max(...timestamps) : 0;
    steps.push({
      tier,
      firstSeenAt,
      lastSeenAt,
      count: items.length,
      sources: Array.from(new Set(items.map((item) => item.source))).slice(0, 8),
    });
  }

  const fringe = steps.find((step) => step.tier === "fringe");
  const mainstream = steps.find((step) => step.tier === "mainstream");
  const lagToMainstreamMs =
    fringe && mainstream && fringe.firstSeenAt > 0 && mainstream.firstSeenAt > fringe.firstSeenAt
      ? mainstream.firstSeenAt - fringe.firstSeenAt
      : undefined;

  return { steps, lagToMainstreamMs };
}

const DOMAIN_ALIASES: Record<string, string> = {
  "reuters.com": "Reuters",
  "apnews.com": "AP",
  "bbc.co.uk": "BBC",
  "bbc.com": "BBC",
  "cnn.com": "CNN",
  "nytimes.com": "NYTimes",
  "wsj.com": "WSJ",
  "washingtonpost.com": "WaPo",
  "theguardian.com": "Guardian",
  "foxnews.com": "Fox",
};

function tryDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeSourceLabel(source: string, link: string): string {
  const domain = link ? tryDomain(link) : null;
  if (domain) {
    for (const [key, label] of Object.entries(DOMAIN_ALIASES)) {
      if (domain === key || domain.endsWith(`.${key}`)) {
        return label;
      }
    }
    return domain;
  }
  return source?.trim() ? source.trim() : "Unknown";
}

function extractCitationTargets(text: string): string[] {
  const targets = new Set<string>();

  const urls = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  for (const url of urls) {
    const trimmed = url.replace(/[),.]+$/g, "");
    const domain = tryDomain(trimmed);
    if (!domain) {
      continue;
    }
    targets.add(domain);
  }

  const lower = text.toLowerCase();
  const mentions = new Map<string, string>([
    ["reuters", "Reuters"],
    ["ap news", "AP"],
    ["associated press", "AP"],
    ["bbc", "BBC"],
    ["cnn", "CNN"],
    ["nytimes", "NYTimes"],
    ["wsj", "WSJ"],
    ["wapo", "WaPo"],
    ["guardian", "Guardian"],
    ["fox news", "Fox"],
  ]);
  for (const [needle, label] of mentions.entries()) {
    if (lower.includes(needle)) {
      targets.add(label);
    }
  }

  return Array.from(targets);
}

function normalizeCitationTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.includes(".")) {
    return trimmed;
  }
  for (const [key, label] of Object.entries(DOMAIN_ALIASES)) {
    if (trimmed === key || trimmed.endsWith(`.${key}`) || trimmed.endsWith(key)) {
      return label;
    }
  }
  return trimmed;
}

function buildCitationChain(matches: SituationNewsItem[]): CitationChain {
  const maxItems = 60;
  const items = matches
    .slice()
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, maxItems);

  const nodes = new Set<string>();
  const edgeWeights = new Map<string, number>();
  let citedByCount = 0;

  for (const item of items) {
    const from = normalizeSourceLabel(item.source ?? "", item.link ?? "");
    nodes.add(from);
    const text = normalizeForMatch(item);
    const rawTargets = extractCitationTargets(text);
    const targets = rawTargets.map(normalizeCitationTarget).filter(Boolean);

    const uniqueTargets = new Set<string>();
    for (const target of targets) {
      if (!target || target === from) {
        continue;
      }
      uniqueTargets.add(target);
    }

    if (uniqueTargets.size > 0) {
      citedByCount += 1;
    }
    for (const target of uniqueTargets) {
      nodes.add(target);
      const key = `${from}=>${target}`;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
    }
  }

  const links: CitationLink[] = Array.from(edgeWeights.entries())
    .map(([key, weight]) => {
      const parts = key.split("=>");
      const from = parts[0] ?? "";
      const to = parts[1] ?? "";
      return from && to ? { from, to, weight } : null;
    })
    .filter((entry): entry is CitationLink => Boolean(entry))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 25);

  const inWeights = new Map<string, number>();
  for (const link of links) {
    inWeights.set(link.to, (inWeights.get(link.to) ?? 0) + link.weight);
  }
  const topCited = Array.from(inWeights.entries())
    .map(([source, weight]) => ({ source, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);

  return {
    nodes: Array.from(nodes).slice(0, 30),
    links,
    topCited,
    citedByCount,
  };
}

function buildCredibility(options: {
  matches: SituationNewsItem[];
  radar: CrossSourceRadar;
  citation: CitationChain;
  feedback: { falsePositive: number; falseNegative: number };
}): CredibilityAssessment {
  const sourcesByTier: Record<"fringe" | "alternative" | "mainstream" | "unknown", Set<string>> = {
    fringe: new Set(),
    alternative: new Set(),
    mainstream: new Set(),
    unknown: new Set(),
  };

  for (const item of options.matches) {
    const tier = classifySource(item.source ?? "") ?? "unknown";
    sourcesByTier[tier].add(normalizeSourceLabel(item.source ?? "", item.link ?? ""));
  }

  const allSources = new Set<string>([
    ...sourcesByTier.fringe,
    ...sourcesByTier.alternative,
    ...sourcesByTier.mainstream,
    ...sourcesByTier.unknown,
  ]);
  const totalSources = allSources.size;

  const sourceReliability =
    totalSources === 0
      ? 0
      : (sourcesByTier.mainstream.size * 0.85 +
          sourcesByTier.alternative.size * 0.6 +
          sourcesByTier.fringe.size * 0.3 +
          sourcesByTier.unknown.size * 0.5) /
        totalSources;

  const corroboration = clamp01(totalSources / 6);
  const citationSupport = clamp01(options.citation.citedByCount / Math.max(1, options.matches.length));
  const divergence = clamp01(options.radar.divergence);
  const feedbackPenalty = clamp01(options.feedback.falsePositive / (options.feedback.falsePositive + 3));

  let score01 =
    0.5 * clamp01(sourceReliability) +
    0.25 * corroboration +
    0.15 * citationSupport +
    0.1 * (1 - divergence);
  score01 = clamp01(score01 * (1 - 0.4 * feedbackPenalty));

  const score = Math.round(score01 * 100);
  const level: CredibilityAssessment["level"] = score >= 70 ? "high" : score >= 45 ? "medium" : "low";

  const reasons: string[] = [];
  if (sourcesByTier.mainstream.size > 0) {
    reasons.push("Mainstream coverage present");
  } else if (sourcesByTier.fringe.size > 0) {
    reasons.push("Primarily fringe sources");
  }
  if (divergence >= 0.6) {
    reasons.push("High cross-source divergence");
  }
  if (citationSupport < 0.2) {
    reasons.push("Weak citation/attribution signals");
  }
  if (options.feedback.falsePositive >= 2) {
    reasons.push("Recent false-positive feedback");
  }

  return {
    score,
    level,
    reasons: reasons.slice(0, 4),
    components: {
      sourceReliability: clamp01(sourceReliability),
      corroboration,
      citationSupport,
      divergence,
      feedbackPenalty,
    },
  };
}

export function analyzeNarratives(
  allNews: SituationNewsItem[],
  options?: { learning?: Map<string, NarrativeLearningOverride> },
): NarrativeResults | null {
  if (!allNews || allNews.length === 0) return null;

  const results: NarrativeResults = {
    emergingFringe: [],
    fringeToMainstream: [],
    narrativeWatch: [],
    disinfoSignals: [],
  };

  for (const narrative of NARRATIVE_PATTERNS) {
    const learning = options?.learning?.get(narrative.id);
    const boostedTokens = Array.isArray(learning?.boostedTokens) ? learning?.boostedTokens : [];
    const blockedTokens = Array.isArray(learning?.blockedTokens) ? learning?.blockedTokens : [];
    const suppressed = new Set(
      Array.isArray(learning?.suppressedItemMetaIds) ? learning?.suppressedItemMetaIds : [],
    );
    const feedback = {
      falsePositive: typeof learning?.falsePositiveCount === "number" ? learning.falsePositiveCount : 0,
      falseNegative: typeof learning?.falseNegativeCount === "number" ? learning.falseNegativeCount : 0,
    };

    const keywords = [...narrative.keywords, ...boostedTokens].map((kw) => kw.toLowerCase()).filter(Boolean);
    const matches: SituationNewsItem[] = [];
    const sourceMatches: {
      fringe: SituationNewsItem[];
      alternative: SituationNewsItem[];
      mainstream: SituationNewsItem[];
    } = {
      fringe: [],
      alternative: [],
      mainstream: [],
    };

    for (const item of allNews) {
      const source = (item.source || "").toLowerCase();

      if (item.itemMetaId && suppressed.has(item.itemMetaId)) {
        continue;
      }

      const haystack = normalizeForMatch(item);
      if (blockedTokens.length > 0) {
        const blocked = blockedTokens.some((token) => token && haystack.includes(token.toLowerCase()));
        if (blocked) {
          continue;
        }
      }

      const hasMatch = keywords.some((kw) => haystack.includes(kw));
      if (!hasMatch) {
        continue;
      }

      matches.push(item);

      const sourceType = classifySource(source);
      if (sourceType) {
        sourceMatches[sourceType].push(item);
      }
    }

    if (matches.length === 0) {
      continue;
    }

    const sortedMatches = matches.slice().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    const narrativeData: NarrativeData = {
      id: narrative.id,
      name: formatNarrativeName(narrative.id),
      category: narrative.category,
      severity: narrative.severity,
      count: sortedMatches.length,
      fringeCount: sourceMatches.fringe.length,
      alternativeCount: sourceMatches.alternative.length,
      mainstreamCount: sourceMatches.mainstream.length,
      sources: [...new Set(sortedMatches.map((m) => m.source))].slice(0, 5),
      headlines: sortedMatches.slice(0, 3),
      keywords: narrative.keywords,
      feedback,
      learning: {
        boostedTokens: boostedTokens.slice(0, 8),
        blockedTokens: blockedTokens.slice(0, 8),
        suppressedCount: suppressed.size,
      },
    };

    const radar = buildCrossSourceRadar(sortedMatches);
    const path = buildFringeMainstreamPath(sortedMatches);
    const citationChain = buildCitationChain(sortedMatches);
    const credibility = buildCredibility({ matches: sortedMatches, radar, citation: citationChain, feedback });
    narrativeData.model = {
      crossSourceRadar: radar,
      fringeToMainstreamPath: path,
      credibility,
      citationChain,
    };

    if (sourceMatches.mainstream.length > 0 && sourceMatches.fringe.length > 0) {
      results.fringeToMainstream.push({
        ...narrativeData,
        status: "crossing",
        crossoverLevel: sourceMatches.mainstream.length / Math.max(1, sortedMatches.length),
      });
    } else if (narrative.severity === "disinfo") {
      results.disinfoSignals.push(narrativeData);
    } else if (sourceMatches.fringe.length > 0 || sourceMatches.alternative.length > 0) {
      const status: EmergingFringe["status"] =
        sortedMatches.length >= 5 ? "viral" : sortedMatches.length >= 3 ? "spreading" : "emerging";

      results.emergingFringe.push({
        ...narrativeData,
        status,
      });
    } else {
      results.narrativeWatch.push(narrativeData);
    }
  }

  results.emergingFringe.sort((a, b) => b.count - a.count);
  results.fringeToMainstream.sort((a, b) => b.crossoverLevel - a.crossoverLevel);
  results.narrativeWatch.sort((a, b) => b.count - a.count);
  results.disinfoSignals.sort((a, b) => b.count - a.count);

  return results;
}

export function getNarrativeSummary(results: NarrativeResults | null): { total: number; status: string } {
  if (!results) {
    return { total: 0, status: "NO DATA" };
  }

  const total =
    results.emergingFringe.length +
    results.fringeToMainstream.length +
    results.narrativeWatch.length +
    results.disinfoSignals.length;

  return {
    total,
    status: total > 0 ? `${total} ACTIVE` : "MONITORING",
  };
}
