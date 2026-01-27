import { CORRELATION_TOPICS, type CorrelationTopic } from "./patterns";
import type { SituationNewsItem } from "./types";

export interface CorrelationLearningOverride {
  boostedTokens?: string[];
  blockedTokens?: string[];
  suppressedItemMetaIds?: string[];
  falsePositiveCount?: number;
  falseNegativeCount?: number;
}

export interface CorrelationFeedbackStats {
  falsePositive: number;
  falseNegative: number;
}

export interface CorrelationLearningSnapshot {
  boostedTokens: string[];
  blockedTokens: string[];
  suppressedCount: number;
}

export interface EmergingPattern {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[];
  feedback?: CorrelationFeedbackStats;
  learning?: CorrelationLearningSnapshot;
}

export interface MomentumSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[];
  feedback?: CorrelationFeedbackStats;
  learning?: CorrelationLearningSnapshot;
}

export interface CrossSourceCorrelation {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[];
  feedback?: CorrelationFeedbackStats;
  learning?: CorrelationLearningSnapshot;
}

export interface PredictiveSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  predictionZh?: string;
  level: "high" | "medium" | "low";
  headlines: { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[];
  feedback?: CorrelationFeedbackStats;
  learning?: CorrelationLearningSnapshot;
}

export interface CorrelationResults {
  emergingPatterns: EmergingPattern[];
  momentumSignals: MomentumSignal[];
  crossSourceCorrelations: CrossSourceCorrelation[];
  predictiveSignals: PredictiveSignal[];
}

function formatTopicName(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function normalizeForMatch(item: SituationNewsItem): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  if (item.summary) parts.push(item.summary);
  if (Array.isArray(item.keyPoints) && item.keyPoints.length > 0) {
    parts.push(item.keyPoints.join(" "));
  }
  return parts.join(" ").trim();
}

function normalizeTokens(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, 12);
}

function normalizeSuppressed(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  const set = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      set.add(entry.trim());
    }
  }
  return set;
}

function getPrediction(topic: CorrelationTopic, count: number): string {
  if (topic.id === "tariffs" && count >= 4) {
    return "Market volatility likely in next 24-48h";
  }
  if (topic.id === "fed-rates") {
    return "Expect increased financial sector coverage";
  }
  if (topic.id.includes("china") || topic.id.includes("russia")) {
    return "Geopolitical escalation narrative forming";
  }
  if (topic.id === "layoffs") {
    return "Employment concerns may dominate news cycle";
  }
  if (topic.category === "Conflict") {
    return "Breaking developments likely within hours";
  }
  return "Topic gaining mainstream traction";
}

export function analyzeCorrelations(
  allNews: SituationNewsItem[],
  options?: { previousCounts?: Record<string, number> | null; learning?: Map<string, CorrelationLearningOverride> }
): { results: CorrelationResults | null; topicCounts: Record<string, number> } {
  if (!allNews || allNews.length === 0) {
    return { results: null, topicCounts: {} };
  }

  const results: CorrelationResults = {
    emergingPatterns: [],
    momentumSignals: [],
    crossSourceCorrelations: [],
    predictiveSignals: [],
  };

  const overridesByTopicId: Record<
    string,
    {
      boostedTokens: string[];
      blockedTokens: string[];
      suppressedItemMetaIds: Set<string>;
      feedback: CorrelationFeedbackStats;
      learning: CorrelationLearningSnapshot;
    }
  > = {};

  for (const topic of CORRELATION_TOPICS) {
    const override = options?.learning?.get(topic.id);
    const boostedTokens = normalizeTokens(override?.boostedTokens);
    const blockedTokens = normalizeTokens(override?.blockedTokens);
    const suppressedItemMetaIds = normalizeSuppressed(override?.suppressedItemMetaIds);
    const falsePositive =
      typeof override?.falsePositiveCount === "number" && Number.isFinite(override.falsePositiveCount)
        ? Math.max(0, Math.trunc(override.falsePositiveCount))
        : 0;
    const falseNegative =
      typeof override?.falseNegativeCount === "number" && Number.isFinite(override.falseNegativeCount)
        ? Math.max(0, Math.trunc(override.falseNegativeCount))
        : 0;
    overridesByTopicId[topic.id] = {
      boostedTokens,
      blockedTokens,
      suppressedItemMetaIds,
      feedback: { falsePositive, falseNegative },
      learning: { boostedTokens, blockedTokens, suppressedCount: suppressedItemMetaIds.size },
    };
  }

  const topicCounts: Record<string, number> = {};
  const topicSources: Record<string, Set<string>> = {};
  const topicHeadlines: Record<
    string,
    { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[]
  > = {};

  for (const item of allNews) {
    const source = item.source || "Unknown";
    const itemMetaId = item.itemMetaId;
    const haystack = normalizeForMatch(item);
    const lowerHaystack = haystack.toLowerCase();

    for (const topic of CORRELATION_TOPICS) {
      const override = overridesByTopicId[topic.id];
      if (override?.suppressedItemMetaIds && itemMetaId && override.suppressedItemMetaIds.has(itemMetaId)) {
        continue;
      }

      const matches = topic.patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(haystack);
      });
      const boostedMatch =
        override?.boostedTokens?.length && override.boostedTokens.some((token) => lowerHaystack.includes(token));
      const combinedMatch = Boolean(matches || boostedMatch);
      if (
        combinedMatch &&
        override?.blockedTokens?.length &&
        override.blockedTokens.some((token) => lowerHaystack.includes(token))
      ) {
        continue;
      }
      if (!combinedMatch) {
        continue;
      }

      topicCounts[topic.id] = (topicCounts[topic.id] ?? 0) + 1;

      const sourcesForTopic = topicSources[topic.id] ?? new Set<string>();
      topicSources[topic.id] = sourcesForTopic;
      sourcesForTopic.add(source);

      const headlinesForTopic =
        topicHeadlines[topic.id] ??
        ([] as { title: string; titleZh?: string; link: string; source: string; itemMetaId?: string }[]);
      topicHeadlines[topic.id] = headlinesForTopic;
      if (headlinesForTopic.length < 5) {
        headlinesForTopic.push({ title: item.title, titleZh: item.titleZh, link: item.link, source, itemMetaId });
      }
    }
  }

  const previousCounts = options?.previousCounts ?? {};

  for (const topic of CORRELATION_TOPICS) {
    const override = overridesByTopicId[topic.id];
    const count = topicCounts[topic.id] || 0;
    const sourcesSet = topicSources[topic.id];
    const sources = sourcesSet ? Array.from(sourcesSet) : [];
    const headlines = topicHeadlines[topic.id] || [];
    const oldCount = previousCounts[topic.id] || 0;
    const delta = count - oldCount;

    if (count >= 3) {
      const level: EmergingPattern["level"] =
        count >= 8 ? "high" : count >= 5 ? "elevated" : "emerging";

      results.emergingPatterns.push({
        id: topic.id,
        name: formatTopicName(topic.id),
        category: topic.category,
        count,
        level,
        sources,
        headlines,
        feedback: override?.feedback,
        learning: override?.learning,
      });
    }

    if (delta >= 2 || (count >= 3 && delta >= 1)) {
      const momentum: MomentumSignal["momentum"] =
        delta >= 4 ? "surging" : delta >= 2 ? "rising" : "stable";

      results.momentumSignals.push({
        id: topic.id,
        name: formatTopicName(topic.id),
        category: topic.category,
        current: count,
        delta,
        momentum,
        headlines,
        feedback: override?.feedback,
        learning: override?.learning,
      });
    }

    if (sources.length >= 3) {
      const level: CrossSourceCorrelation["level"] =
        sources.length >= 5 ? "high" : sources.length >= 4 ? "elevated" : "emerging";

      results.crossSourceCorrelations.push({
        id: topic.id,
        name: formatTopicName(topic.id),
        category: topic.category,
        sourceCount: sources.length,
        sources,
        level,
        headlines,
        feedback: override?.feedback,
        learning: override?.learning,
      });
    }

    const score = count * 2 + sources.length * 3 + delta * 5;
    if (score >= 15) {
      const confidence = Math.min(95, Math.round(score * 1.5));
      const prediction = getPrediction(topic, count);
      const level: PredictiveSignal["level"] =
        confidence >= 70 ? "high" : confidence >= 50 ? "medium" : "low";

      results.predictiveSignals.push({
        id: topic.id,
        name: formatTopicName(topic.id),
        category: topic.category,
        score,
        confidence,
        prediction,
        level,
        headlines,
        feedback: override?.feedback,
        learning: override?.learning,
      });
    }
  }

  results.emergingPatterns.sort((a, b) => b.count - a.count);
  results.momentumSignals.sort((a, b) => b.delta - a.delta);
  results.crossSourceCorrelations.sort((a, b) => b.sourceCount - a.sourceCount);
  results.predictiveSignals.sort((a, b) => b.score - a.score);

  return { results, topicCounts };
}

export function getCorrelationSummary(results: CorrelationResults | null): {
  totalSignals: number;
  status: string;
  statusZh?: string;
} {
  if (!results) {
    return { totalSignals: 0, status: "NO DATA" };
  }

  const totalSignals =
    results.emergingPatterns.length +
    results.momentumSignals.length +
    results.predictiveSignals.length;

  return {
    totalSignals,
    status: totalSignals > 0 ? `${totalSignals} SIGNALS` : "MONITORING",
  };
}
