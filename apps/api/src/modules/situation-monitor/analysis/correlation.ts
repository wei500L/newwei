import { CORRELATION_TOPICS, type CorrelationTopic } from "./patterns";
import type { SituationNewsItem } from "./types";

export interface EmergingPattern {
  id: string;
  name: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: { title: string; titleZh?: string; link: string; source: string }[];
}

export interface MomentumSignal {
  id: string;
  name: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: { title: string; titleZh?: string; link: string; source: string }[];
}

export interface CrossSourceCorrelation {
  id: string;
  name: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: { title: string; titleZh?: string; link: string; source: string }[];
}

export interface PredictiveSignal {
  id: string;
  name: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  level: "high" | "medium" | "low";
  headlines: { title: string; titleZh?: string; link: string; source: string }[];
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
  options?: { previousCounts?: Record<string, number> | null }
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

  const topicCounts: Record<string, number> = {};
  const topicSources: Record<string, Set<string>> = {};
  const topicHeadlines: Record<string, { title: string; link: string; source: string }[]> = {};

  for (const item of allNews) {
    const title = item.title || "";
    const source = item.source || "Unknown";

    for (const topic of CORRELATION_TOPICS) {
      const matches = topic.patterns.some((pattern) => pattern.test(title));
      if (!matches) {
        continue;
      }

      topicCounts[topic.id] = (topicCounts[topic.id] ?? 0) + 1;

      const sourcesForTopic = topicSources[topic.id] ?? new Set<string>();
      topicSources[topic.id] = sourcesForTopic;
      sourcesForTopic.add(source);

      const headlinesForTopic =
        topicHeadlines[topic.id] ?? ([] as { title: string; link: string; source: string }[]);
      topicHeadlines[topic.id] = headlinesForTopic;
      if (headlinesForTopic.length < 5) {
        headlinesForTopic.push({ title, link: item.link, source });
      }
    }
  }

  const previousCounts = options?.previousCounts ?? {};

  for (const topic of CORRELATION_TOPICS) {
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
