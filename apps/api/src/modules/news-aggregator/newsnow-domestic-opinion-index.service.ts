import { ProcessedItemModel } from '@modular/mongo';
import { Injectable } from '@nestjs/common';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { ArchiveClassifier } from '../archive/archive.classifier';
import { ArchiveVertical } from '../archive/archive.types';
import { PrismaService } from '../config/prisma.service';

import { genMetadata } from './data/metadata';
import { genSources } from './data/pre-sources';
import {
  NewsnowDataState,
  NewsnowDomesticOpinionEmptyReason,
} from './news-aggregator.types';
import type {
  NewsnowCandidateKeywordSummary,
  NewsnowDomesticOpinionDiagnostics,
  NewsnowDomesticOpinionIndexBreakdownPoint,
  NewsnowDomesticOpinionIndexBreakdownSourcePoint,
  NewsnowDomesticOpinionIndexBreakdownTopKeywords,
  NewsnowDomesticOpinionIndexPipelineBreakdownSourcePoint,
  NewsnowDomesticOpinionIndexPoint,
  NewsnowDomesticOpinionIndexResponse,
} from './news-aggregator.types';

const DEFAULT_TREND_HOURS = 24;
const MAX_TREND_HOURS = 168;
const MAX_KEYWORDS_PER_CANDIDATE = 10;
const MAX_KEYWORDS_PER_INDEX = 12;
const MAX_TOP_CANDIDATES = 6;
const NEWSNOW_BLEND_WEIGHT = 0.75;
const PIPELINE_BLEND_WEIGHT = 0.25;
const PIPELINE_KEYWORD_NEGATIVE_BOOST = 1.2;
const PIPELINE_FALLBACK_QUALITY_SCORE = 0.5;
const PIPELINE_ATTENTION_NORMALIZER = Math.log1p(12);
const PIPELINE_BREADTH_NORMALIZER = Math.log1p(6);
const CJK_KEYWORD_RE = /[\u3400-\u9fff]{2,8}/g;
const LATIN_KEYWORD_RE = /[A-Za-z0-9][A-Za-z0-9.+-]{1,30}/g;
const NEWSNOW_METADATA = genMetadata(genSources());
const DOMESTIC_SOURCE_IDS = new Set<string>(
  Array.isArray(NEWSNOW_METADATA.china?.sources)
    ? NEWSNOW_METADATA.china.sources.filter(
        (sourceId) => typeof sourceId === 'string' && sourceId.trim().length > 0,
      )
    : [],
);

type CandidateKeywordSource = 'topic' | 'entity' | 'title';
type SentimentLabel = 'positive' | 'neutral' | 'negative';

interface PersistedCandidateKeyword extends NewsnowCandidateKeywordSummary {
  source: CandidateKeywordSource;
}

export interface NewsnowCandidatePersistenceInput {
  candidateHash: string;
  label: string;
  summary: string | null;
  representativeTitle: string;
  themes: string[];
  topics: string[];
  entities: string[];
  sourceIds: string[];
  domesticSourceIds: string[];
  sourceCount: number;
  itemCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  authorityScore: number;
  domesticSourceCount: number;
  domesticItemCount: number;
  matchedItemIds: string[];
}

interface PersistedCandidateSnapshotRecord {
  candidateHash: string;
  label: string;
  summary: string | null;
  themes: string[];
  keywords: PersistedCandidateKeyword[];
  entities: string[];
  sourceIds: string[];
  domesticSourceIds: string[];
  sourceCount: number;
  itemCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  authorityScore: number;
  domesticSourceCount: number;
  domesticItemCount: number;
  domesticRatio: number;
  isDomestic: boolean;
  sentimentPressure: number;
}

interface NewsnowSnapshotRow {
  bucketStart: Date;
  indexValue: number;
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
  candidateCount: number;
  keywordSummary: unknown;
}

interface PipelineProcessedArticleRow {
  id: string;
  title: string | null;
  summary: string | null;
  topics: unknown;
  entities: unknown;
  qualityScore: number | null;
  language: string | null;
  location: string | null;
  publishedAt: Date | null;
  eventAt: Date;
  processedAt: Date;
  cleanedMarkdownRef: string | null;
  article: {
    crawlAt: Date;
    sourceId: string | null;
    source: {
      language: string | null;
    } | null;
  };
}

interface ProcessedItemSignal {
  sentiment: SentimentLabel | null;
  sourceId: string | null;
}

interface PipelineBucketAccumulator {
  bucketStart: Date;
  articleCount: number;
  sourceIds: Set<string>;
  newestArticleAtMs: number;
  sentimentDocCount: number;
  negativeCount: number;
  keywordWeights: Map<string, NewsnowCandidateKeywordSummary>;
}

interface PipelineBucketSummary {
  bucketStart: Date;
  indexValue: number;
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
  articleCount: number;
  sourceCount: number;
  keywords: NewsnowCandidateKeywordSummary[];
}

interface MergedBucketSummary {
  bucketStart: Date;
  point: NewsnowDomesticOpinionIndexPoint;
  newsnow: NewsnowSnapshotRow | null;
  pipeline: PipelineBucketSummary | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(4));
}

function normalizeKeywordDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeKeywordKey(value: string): string {
  return normalizeKeywordDisplay(value).toLowerCase();
}

function extractTitleFallbackKeywords(title: string): string[] {
  const normalized = normalizeKeywordDisplay(title);
  if (!normalized) {
    return [];
  }

  const results: string[] = [];
  const seen = new Set<string>();

  for (const match of normalized.match(CJK_KEYWORD_RE) ?? []) {
    const keyword = normalizeKeywordDisplay(match);
    const key = normalizeKeywordKey(keyword);
    if (!keyword || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(keyword);
    if (results.length >= MAX_KEYWORDS_PER_CANDIDATE) {
      return results;
    }
  }

  for (const match of normalized.match(LATIN_KEYWORD_RE) ?? []) {
    const keyword = normalizeKeywordDisplay(match);
    const key = normalizeKeywordKey(keyword);
    if (!keyword || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(keyword);
    if (results.length >= MAX_KEYWORDS_PER_CANDIDATE) {
      break;
    }
  }

  return results;
}

function toUtcHourStart(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      value.getUTCHours(),
      0,
      0,
      0,
    ),
  );
}

function sanitizeKeywordSummary(value: unknown): NewsnowCandidateKeywordSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const keyword =
        typeof (entry as { keyword?: unknown }).keyword === 'string'
          ? normalizeKeywordDisplay((entry as { keyword: string }).keyword)
          : '';
      const weight =
        typeof (entry as { weight?: unknown }).weight === 'number' &&
        Number.isFinite((entry as { weight: number }).weight)
          ? roundMetric((entry as { weight: number }).weight)
          : 0;
      if (!keyword || weight <= 0) {
        return null;
      }
      return { keyword, weight };
    })
    .filter((entry): entry is NewsnowCandidateKeywordSummary => Boolean(entry));
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? normalizeKeywordDisplay(entry) : ''))
    .filter((entry) => entry.length > 0);
}

function sanitizeEntityNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return normalizeKeywordDisplay(entry);
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return '';
      }
      return typeof (entry as { name?: unknown }).name === 'string'
        ? normalizeKeywordDisplay((entry as { name: string }).name)
        : '';
    })
    .filter((entry) => entry.length > 0);
}

function normalizeSentimentLabel(value: unknown): SentimentLabel | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'positive' || normalized === 'neutral' || normalized === 'negative') {
    return normalized;
  }
  return null;
}

function isZhLanguage(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith('zh') ||
    normalized === 'cn' ||
    normalized.includes('chinese')
  );
}

function computeIndexValue(input: {
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
}) {
  return clamp01(
    input.attentionScore * 0.5 +
      input.breadthScore * 0.2 +
      input.freshnessScore * 0.2 +
      input.sentimentPressure * 0.1,
  );
}

function mergeWeightedMetric(
  newsnowValue: number | null,
  pipelineValue: number | null,
  newsnowWeight: number,
  pipelineWeight: number,
): number {
  if (newsnowValue == null && pipelineValue == null) {
    return 0;
  }
  if (newsnowValue == null) {
    return roundMetric(pipelineValue ?? 0);
  }
  if (pipelineValue == null) {
    return roundMetric(newsnowValue);
  }
  const totalWeight = newsnowWeight + pipelineWeight;
  if (totalWeight <= 0) {
    return roundMetric((newsnowValue + pipelineValue) / 2);
  }
  return roundMetric((newsnowValue * newsnowWeight + pipelineValue * pipelineWeight) / totalWeight);
}

@Injectable()
export class NewsnowDomesticOpinionIndexService {
  private readonly archiveClassifier = new ArchiveClassifier();

  constructor(private readonly prisma: PrismaService) {}

  async persistSnapshots(input: {
    orgId: string;
    generatedAt: Date;
    totalDomesticSourceCount: number;
    candidates: NewsnowCandidatePersistenceInput[];
  }) {
    const bucketStart = toUtcHourStart(input.generatedAt);
    const uniqueItemIds = Array.from(
      new Set(
        input.candidates.flatMap((candidate) =>
          candidate.matchedItemIds
            .map((itemId) => itemId.trim())
            .filter((itemId) => itemId.length > 0),
        ),
      ),
    );
    const sentimentLabels = await this.loadLatestSentimentLabels(input.orgId, uniqueItemIds);
    const persistedCandidates = input.candidates.map((candidate) =>
      this.buildPersistedCandidate(candidate, sentimentLabels),
    );
    const keywordSummary = this.summarizeKeywords(persistedCandidates);
    const indexSnapshot = this.buildIndexSnapshot({
      candidates: persistedCandidates,
      totalDomesticSourceCount: input.totalDomesticSourceCount,
      keywordSummary,
    });
    const candidateHashes = persistedCandidates.map((candidate) => candidate.candidateHash);

    await this.prisma.runInTransaction(async (tx) => {
      await tx.newsnowCandidateSnapshot.deleteMany({
        where: {
          orgId: input.orgId,
          bucketStart,
          ...(candidateHashes.length > 0
            ? { candidateHash: { notIn: candidateHashes } }
            : {}),
        },
      });

      for (const candidate of persistedCandidates) {
        await tx.newsnowCandidateSnapshot.upsert({
          where: {
            orgId_bucketStart_candidateHash: {
              orgId: input.orgId,
              bucketStart,
              candidateHash: candidate.candidateHash,
            },
          },
          update: {
            label: candidate.label,
            summary: candidate.summary,
            themes: toPrismaJsonValue(candidate.themes),
            keywords: toPrismaJsonValue(candidate.keywords),
            entities: toPrismaJsonValue(candidate.entities),
            sourceIds: toPrismaJsonValue(candidate.sourceIds),
            sourceCount: candidate.sourceCount,
            itemCount: candidate.itemCount,
            heatScore: candidate.heatScore,
            freshnessScore: candidate.freshnessScore,
            candidateScore: candidate.candidateScore,
            authorityScore: candidate.authorityScore,
            domesticSourceCount: candidate.domesticSourceCount,
            domesticItemCount: candidate.domesticItemCount,
            domesticRatio: candidate.domesticRatio,
            isDomestic: candidate.isDomestic,
            sentimentPressure: candidate.sentimentPressure,
          },
          create: {
            orgId: input.orgId,
            bucketStart,
            candidateHash: candidate.candidateHash,
            label: candidate.label,
            summary: candidate.summary,
            themes: toPrismaJsonValue(candidate.themes),
            keywords: toPrismaJsonValue(candidate.keywords),
            entities: toPrismaJsonValue(candidate.entities),
            sourceIds: toPrismaJsonValue(candidate.sourceIds),
            sourceCount: candidate.sourceCount,
            itemCount: candidate.itemCount,
            heatScore: candidate.heatScore,
            freshnessScore: candidate.freshnessScore,
            candidateScore: candidate.candidateScore,
            authorityScore: candidate.authorityScore,
            domesticSourceCount: candidate.domesticSourceCount,
            domesticItemCount: candidate.domesticItemCount,
            domesticRatio: candidate.domesticRatio,
            isDomestic: candidate.isDomestic,
            sentimentPressure: candidate.sentimentPressure,
          },
        });
      }

      await tx.newsnowDomesticOpinionIndexSnapshot.upsert({
        where: {
          orgId_bucketStart: {
            orgId: input.orgId,
            bucketStart,
          },
        },
        update: {
          indexValue: indexSnapshot.indexValue,
          attentionScore: indexSnapshot.attentionScore,
          breadthScore: indexSnapshot.breadthScore,
          freshnessScore: indexSnapshot.freshnessScore,
          sentimentPressure: indexSnapshot.sentimentPressure,
          candidateCount: indexSnapshot.candidateCount,
          keywordSummary: toPrismaJsonValue(indexSnapshot.keywordSummary),
        },
        create: {
          orgId: input.orgId,
          bucketStart,
          indexValue: indexSnapshot.indexValue,
          attentionScore: indexSnapshot.attentionScore,
          breadthScore: indexSnapshot.breadthScore,
          freshnessScore: indexSnapshot.freshnessScore,
          sentimentPressure: indexSnapshot.sentimentPressure,
          candidateCount: indexSnapshot.candidateCount,
          keywordSummary: toPrismaJsonValue(indexSnapshot.keywordSummary),
        },
      });
    });
  }

  async getDomesticOpinionIndex(
    orgId: string,
    options?: { hours?: number },
  ): Promise<NewsnowDomesticOpinionIndexResponse> {
    const hours = Math.min(
      Math.max(Math.trunc(options?.hours ?? DEFAULT_TREND_HOURS), 1),
      MAX_TREND_HOURS,
    );
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const trendRows = (await this.prisma.newsnowDomesticOpinionIndexSnapshot.findMany({
      where: {
        orgId,
        bucketStart: { gte: since },
      },
      orderBy: [{ bucketStart: 'asc' }],
    })) as NewsnowSnapshotRow[];
    const pipelineTrend = await this.loadPipelineTrend(orgId, since);
    const mergedTrend = this.mergeTrendRows(trendRows, pipelineTrend);
    const latest = mergedTrend.at(-1) ?? null;
    const diagnostics: NewsnowDomesticOpinionDiagnostics = {
      requestedHours: hours,
      snapshotCount: trendRows.length,
      pipelineBucketCount: pipelineTrend.length,
    };

    if (!latest) {
      return this.buildEmptyResponse(diagnostics);
    }

    const topCandidates = latest.newsnow
      ? await this.loadTopCandidatesForBucket(orgId, latest.newsnow.bucketStart)
      : [];
    const breakdownTopKeywords = this.buildBreakdownTopKeywords(latest);
    const topKeywords = this.mergeKeywordSummaries([
      ...breakdownTopKeywords.newsnow,
      ...breakdownTopKeywords.pipeline,
    ]);

    return {
      generatedAt: new Date().toISOString(),
      dataState: NewsnowDataState.Ready,
      emptyReason: null,
      diagnostics,
      latest: latest.point,
      trend: mergedTrend.map((row) => row.point),
      topKeywords,
      topCandidates,
      breakdown: {
        latest: this.toBreakdownPoint(latest),
        trend: mergedTrend.map((row) => this.toBreakdownPoint(row)),
        topKeywords: breakdownTopKeywords,
      },
    };
  }

  private async loadLatestSentimentLabels(orgId: string, itemMetaIds: string[]) {
    if (itemMetaIds.length === 0) {
      return new Map<string, string>();
    }

    const rows = await ProcessedItemModel.aggregate<{
      itemMetaId: string;
      sentiment?: string | null;
    }>([
      {
        $match: {
          orgId,
          status: 'completed',
          itemMetaId: { $in: itemMetaIds },
        },
      },
      { $sort: { itemMetaId: 1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$itemMetaId',
          itemMetaId: { $first: '$itemMetaId' },
          sentiment: { $first: '$result.sentiment_label' },
        },
      },
      {
        $project: {
          _id: 0,
          itemMetaId: 1,
          sentiment: 1,
        },
      },
    ]);

    return new Map(
      rows
        .map((row) => {
          const itemMetaId =
            typeof row.itemMetaId === 'string' ? row.itemMetaId.trim() : '';
          const sentiment =
            typeof row.sentiment === 'string' ? row.sentiment.trim().toLowerCase() : '';
          if (!itemMetaId || !sentiment) {
            return null;
          }
          return [itemMetaId, sentiment] as const;
        })
        .filter((entry): entry is readonly [string, string] => Boolean(entry)),
    );
  }

  private buildPersistedCandidate(
    candidate: NewsnowCandidatePersistenceInput,
    sentimentLabels: Map<string, string>,
  ): PersistedCandidateSnapshotRecord {
    const sourceIds = sanitizeStringList(candidate.sourceIds);
    const domesticSourceIds = sanitizeStringList(candidate.domesticSourceIds);
    const domesticSourceCount = Math.min(
      Math.max(candidate.domesticSourceCount, 0),
      domesticSourceIds.length || candidate.domesticSourceCount,
    );
    const domesticRatio =
      candidate.sourceCount > 0
        ? clamp01(domesticSourceCount / candidate.sourceCount)
        : 0;
    const keywords = this.buildKeywords(candidate, domesticRatio);
    const matchedSentiments = candidate.matchedItemIds
      .map((itemId) => sentimentLabels.get(itemId.trim()) ?? '')
      .filter((label) => label.length > 0);
    const negativeCount = matchedSentiments.filter((label) => label === 'negative').length;
    const sentimentPressure =
      matchedSentiments.length > 0 ? clamp01(negativeCount / matchedSentiments.length) : 0;

    return {
      candidateHash: candidate.candidateHash,
      label: candidate.label,
      summary: candidate.summary,
      themes: sanitizeStringList(candidate.themes),
      keywords,
      entities: sanitizeStringList(candidate.entities),
      sourceIds,
      domesticSourceIds,
      sourceCount: candidate.sourceCount,
      itemCount: candidate.itemCount,
      heatScore: roundMetric(candidate.heatScore),
      freshnessScore: roundMetric(candidate.freshnessScore),
      candidateScore: roundMetric(candidate.candidateScore),
      authorityScore: roundMetric(candidate.authorityScore),
      domesticSourceCount,
      domesticItemCount: candidate.domesticItemCount,
      domesticRatio,
      isDomestic: domesticSourceCount > 0,
      sentimentPressure,
    };
  }

  private buildKeywords(
    candidate: NewsnowCandidatePersistenceInput,
    domesticRatio: number,
  ): PersistedCandidateKeyword[] {
    const weighted = new Map<string, PersistedCandidateKeyword>();
    const pushKeyword = (
      rawValue: string,
      source: CandidateKeywordSource,
      baseWeight: number,
    ) => {
      const keyword = normalizeKeywordDisplay(rawValue);
      if (!keyword) {
        return;
      }
      const key = normalizeKeywordKey(keyword);
      const candidateWeight =
        baseWeight *
        clamp01(candidate.candidateScore) *
        Math.log1p(Math.max(1, candidate.sourceCount)) *
        domesticRatio;
      if (candidateWeight <= 0) {
        return;
      }
      const nextWeight = roundMetric(candidateWeight);
      const current = weighted.get(key);
      if (!current || nextWeight > current.weight) {
        weighted.set(key, {
          keyword,
          weight: nextWeight,
          source,
        });
      }
    };

    for (const topic of candidate.topics) {
      pushKeyword(topic, 'topic', 1);
    }
    for (const entity of candidate.entities) {
      pushKeyword(entity, 'entity', 0.8);
    }

    if (weighted.size === 0) {
      for (const keyword of extractTitleFallbackKeywords(candidate.representativeTitle)) {
        pushKeyword(keyword, 'title', 0.45);
      }
    }

    return Array.from(weighted.values())
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.keyword.localeCompare(right.keyword);
      })
      .slice(0, MAX_KEYWORDS_PER_CANDIDATE);
  }

  private summarizeKeywords(candidates: PersistedCandidateSnapshotRecord[]) {
    const summary = new Map<string, NewsnowCandidateKeywordSummary>();

    for (const candidate of candidates) {
      if (!candidate.isDomestic) {
        continue;
      }
      for (const keyword of candidate.keywords) {
        const key = normalizeKeywordKey(keyword.keyword);
        const current = summary.get(key);
        if (current) {
          current.weight = roundMetric(current.weight + keyword.weight);
          continue;
        }
        summary.set(key, {
          keyword: keyword.keyword,
          weight: keyword.weight,
        });
      }
    }

    return Array.from(summary.values())
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.keyword.localeCompare(right.keyword);
      })
      .slice(0, MAX_KEYWORDS_PER_INDEX);
  }

  private buildIndexSnapshot(input: {
    candidates: PersistedCandidateSnapshotRecord[];
    totalDomesticSourceCount: number;
    keywordSummary: NewsnowCandidateKeywordSummary[];
  }) {
    const domesticCandidates = input.candidates.filter((candidate) => candidate.isDomestic);
    const totalDomesticSources = Math.max(0, input.totalDomesticSourceCount);
    const uniqueDomesticSourceIds = new Set<string>();

    for (const candidate of domesticCandidates) {
      for (const sourceId of candidate.domesticSourceIds) {
        uniqueDomesticSourceIds.add(sourceId);
      }
    }

    const weightedAverage = (
      resolveValue: (candidate: PersistedCandidateSnapshotRecord) => number,
    ) => {
      let totalWeight = 0;
      let totalValue = 0;
      for (const candidate of domesticCandidates) {
        const weight = Math.max(1, candidate.domesticSourceCount);
        totalWeight += weight;
        totalValue += resolveValue(candidate) * weight;
      }
      return totalWeight > 0 ? clamp01(totalValue / totalWeight) : 0;
    };

    const attentionScore = weightedAverage((candidate) =>
      clamp01(
        (candidate.candidateScore * 0.6 + candidate.heatScore * 0.4) *
          candidate.domesticRatio,
      ),
    );
    const breadthScore =
      totalDomesticSources > 0
        ? clamp01(uniqueDomesticSourceIds.size / totalDomesticSources)
        : 0;
    const freshnessScore = weightedAverage((candidate) =>
      clamp01(candidate.freshnessScore * candidate.domesticRatio),
    );
    const sentimentPressure = weightedAverage((candidate) => candidate.sentimentPressure);
    const indexValue = computeIndexValue({
      attentionScore,
      breadthScore,
      freshnessScore,
      sentimentPressure,
    });

    return {
      indexValue: roundMetric(indexValue),
      attentionScore: roundMetric(attentionScore),
      breadthScore: roundMetric(breadthScore),
      freshnessScore: roundMetric(freshnessScore),
      sentimentPressure: roundMetric(sentimentPressure),
      candidateCount: domesticCandidates.length,
      keywordSummary: input.keywordSummary,
    };
  }

  private buildEmptyResponse(
    diagnostics: NewsnowDomesticOpinionDiagnostics,
  ): NewsnowDomesticOpinionIndexResponse {
    return {
      generatedAt: new Date().toISOString(),
      dataState: NewsnowDataState.Empty,
      emptyReason:
        NewsnowDomesticOpinionEmptyReason.NoRecentSnapshotsOrPipelineData,
      diagnostics,
      latest: null,
      trend: [],
      topKeywords: [],
      topCandidates: [],
      breakdown: {
        latest: null,
        trend: [],
        topKeywords: {
          newsnow: [],
          pipeline: [],
        },
      },
    };
  }

  private async loadTopCandidatesForBucket(orgId: string, bucketStart: Date) {
    const candidateRows = await this.prisma.newsnowCandidateSnapshot.findMany({
      where: {
        orgId,
        bucketStart,
        isDomestic: true,
      },
      select: {
        label: true,
        candidateScore: true,
        domesticRatio: true,
        sourceCount: true,
      },
    });

    return [...candidateRows]
      .sort((left, right) => {
        const rightScore = right.candidateScore * right.domesticRatio;
        const leftScore = left.candidateScore * left.domesticRatio;
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        return right.sourceCount - left.sourceCount;
      })
      .slice(0, MAX_TOP_CANDIDATES)
      .map((row) => ({
        label: row.label,
        candidateScore: roundMetric(row.candidateScore),
        sourceCount: row.sourceCount,
      }));
  }

  private async loadPipelineTrend(orgId: string, since: Date): Promise<PipelineBucketSummary[]> {
    const rows = (await this.prisma.processedArticle.findMany({
      where: {
        status: 'completed',
        orgId,
        eventAt: { gte: since },
      },
      select: {
        id: true,
        title: true,
        summary: true,
        topics: true,
        entities: true,
        qualityScore: true,
        language: true,
        location: true,
        publishedAt: true,
        eventAt: true,
        processedAt: true,
        cleanedMarkdownRef: true,
        article: {
          select: {
            crawlAt: true,
            sourceId: true,
            source: {
              select: {
                language: true,
              },
            },
          },
        },
      },
      orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
    })) as PipelineProcessedArticleRow[];

    if (rows.length === 0) {
      return [];
    }

    const processedItemIds = Array.from(
      new Set(
        rows
          .map((row) => row.cleanedMarkdownRef?.trim() ?? '')
          .filter((value) => value.length > 0),
      ),
    );
    const processedSignals = await this.loadProcessedItemSignals(processedItemIds);
    const buckets = new Map<number, PipelineBucketAccumulator>();

    for (const row of rows) {
      const eventAt = row.eventAt ?? row.publishedAt ?? row.article.crawlAt ?? row.processedAt;
      if (!(eventAt instanceof Date) || Number.isNaN(eventAt.getTime())) {
        continue;
      }
      if (eventAt.getTime() < since.getTime()) {
        continue;
      }

      const bucketStart = toUtcHourStart(eventAt);
      if (bucketStart.getTime() < since.getTime()) {
        continue;
      }

      const processedSignal =
        row.cleanedMarkdownRef && row.cleanedMarkdownRef.trim().length > 0
          ? processedSignals.get(row.cleanedMarkdownRef.trim()) ?? null
          : null;
      const processedSourceId = processedSignal?.sourceId ?? null;
      const sourceKey = processedSourceId ?? row.article.sourceId ?? null;
      const isDomesticSource = processedSourceId
        ? DOMESTIC_SOURCE_IDS.has(processedSourceId)
        : false;
      const hasZhSignal =
        isZhLanguage(row.language) || isZhLanguage(row.article.source?.language ?? null);
      const isDomesticByRule =
        !isDomesticSource &&
        hasZhSignal &&
        this.archiveClassifier.classifyRuleSignals({
          title: row.title,
          summary: row.summary,
          topics: row.topics,
          entities: row.entities,
          location: row.location,
        }).ruleVertical === ArchiveVertical.DOMESTIC_AFFAIRS;

      if (!isDomesticSource && !isDomesticByRule) {
        continue;
      }

      const bucketKey = bucketStart.getTime();
      const accumulator =
        buckets.get(bucketKey) ??
        ({
          bucketStart,
          articleCount: 0,
          sourceIds: new Set<string>(),
          newestArticleAtMs: 0,
          sentimentDocCount: 0,
          negativeCount: 0,
          keywordWeights: new Map<string, NewsnowCandidateKeywordSummary>(),
        } satisfies PipelineBucketAccumulator);
      accumulator.articleCount += 1;
      accumulator.newestArticleAtMs = Math.max(
        accumulator.newestArticleAtMs,
        eventAt.getTime(),
      );
      if (sourceKey && sourceKey.trim().length > 0) {
        accumulator.sourceIds.add(sourceKey.trim());
      }

      const sentiment = processedSignal?.sentiment ?? null;
      if (sentiment) {
        accumulator.sentimentDocCount += 1;
        if (sentiment === 'negative') {
          accumulator.negativeCount += 1;
        }
      }

      for (const keyword of this.buildPipelineKeywords(row, sentiment)) {
        const key = normalizeKeywordKey(keyword.keyword);
        const current = accumulator.keywordWeights.get(key);
        if (current) {
          current.weight = roundMetric(current.weight + keyword.weight);
          continue;
        }
        accumulator.keywordWeights.set(key, {
          keyword: keyword.keyword,
          weight: keyword.weight,
        });
      }

      buckets.set(bucketKey, accumulator);
    }

    return Array.from(buckets.values())
      .map((bucket) => this.finalizePipelineBucket(bucket))
      .sort((left, right) => left.bucketStart.getTime() - right.bucketStart.getTime());
  }

  private async loadProcessedItemSignals(processedItemIds: string[]) {
    if (processedItemIds.length === 0) {
      return new Map<string, ProcessedItemSignal>();
    }

    const rows = (await ProcessedItemModel.find(
      {
        _id: { $in: processedItemIds },
        status: 'completed',
      },
      {
        _id: 1,
        sourceId: 1,
        'result.sentiment_label': 1,
      },
    ).lean()) as {
      _id: unknown;
      sourceId?: unknown;
      result?: {
        sentiment_label?: unknown;
      };
    }[];

    return new Map(
      rows
        .map((row) => {
          const processedItemId =
            typeof row._id === 'string'
              ? row._id.trim()
              : typeof (row._id as { toString?: () => string })?.toString === 'function'
                ? (row._id as { toString: () => string }).toString().trim()
                : '';
          if (!processedItemId) {
            return null;
          }
          const sourceId =
            typeof row.sourceId === 'string' && row.sourceId.trim().length > 0
              ? row.sourceId.trim()
              : null;
          return [
            processedItemId,
            {
              sourceId,
              sentiment: normalizeSentimentLabel(row.result?.sentiment_label),
            } satisfies ProcessedItemSignal,
          ] as const;
        })
        .filter((entry): entry is readonly [string, ProcessedItemSignal] => Boolean(entry)),
    );
  }

  private buildPipelineKeywords(
    row: PipelineProcessedArticleRow,
    sentiment: SentimentLabel | null,
  ): NewsnowCandidateKeywordSummary[] {
    const weighted = new Map<string, NewsnowCandidateKeywordSummary>();
    const normalizedTopics = sanitizeStringList(row.topics);
    const normalizedEntities = sanitizeEntityNames(row.entities);
    const qualityScore =
      typeof row.qualityScore === 'number' && Number.isFinite(row.qualityScore)
        ? clamp01(row.qualityScore)
        : PIPELINE_FALLBACK_QUALITY_SCORE;
    const qualityWeight = 0.6 + 0.4 * qualityScore;
    const sentimentWeight =
      sentiment === 'negative' ? PIPELINE_KEYWORD_NEGATIVE_BOOST : 1;

    const pushKeyword = (value: string, baseWeight: number) => {
      const keyword = normalizeKeywordDisplay(value);
      if (!keyword) {
        return;
      }
      const weight = roundMetric(baseWeight * qualityWeight * sentimentWeight);
      if (weight <= 0) {
        return;
      }
      const key = normalizeKeywordKey(keyword);
      const current = weighted.get(key);
      if (!current || weight > current.weight) {
        weighted.set(key, { keyword, weight });
      }
    };

    for (const topic of normalizedTopics) {
      pushKeyword(topic, 1);
    }
    for (const entity of normalizedEntities) {
      pushKeyword(entity, 0.8);
    }
    if (weighted.size === 0) {
      for (const keyword of extractTitleFallbackKeywords(row.title ?? '')) {
        pushKeyword(keyword, 0.45);
      }
    }

    return Array.from(weighted.values())
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.keyword.localeCompare(right.keyword);
      })
      .slice(0, MAX_KEYWORDS_PER_CANDIDATE);
  }

  private finalizePipelineBucket(bucket: PipelineBucketAccumulator): PipelineBucketSummary {
    const articleCount = bucket.articleCount;
    const sourceCount = bucket.sourceIds.size;
    const bucketEndMs = bucket.bucketStart.getTime() + 60 * 60 * 1000;
    const freshnessScore =
      bucket.newestArticleAtMs > 0
        ? clamp01(1 - (bucketEndMs - bucket.newestArticleAtMs) / (60 * 60 * 1000))
        : 0;
    const attentionScore =
      articleCount > 0 ? clamp01(Math.log1p(articleCount) / PIPELINE_ATTENTION_NORMALIZER) : 0;
    const breadthScore =
      sourceCount > 0 ? clamp01(Math.log1p(sourceCount) / PIPELINE_BREADTH_NORMALIZER) : 0;
    const sentimentPressure =
      bucket.sentimentDocCount > 0
        ? clamp01(bucket.negativeCount / bucket.sentimentDocCount)
        : 0;
    const keywords = Array.from(bucket.keywordWeights.values())
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.keyword.localeCompare(right.keyword);
      })
      .slice(0, MAX_KEYWORDS_PER_INDEX)
      .map((keyword) => ({
        keyword: keyword.keyword,
        weight: roundMetric(keyword.weight),
      }));

    return {
      bucketStart: bucket.bucketStart,
      indexValue: roundMetric(
        computeIndexValue({
          attentionScore,
          breadthScore,
          freshnessScore,
          sentimentPressure,
        }),
      ),
      attentionScore: roundMetric(attentionScore),
      breadthScore: roundMetric(breadthScore),
      freshnessScore: roundMetric(freshnessScore),
      sentimentPressure: roundMetric(sentimentPressure),
      articleCount,
      sourceCount,
      keywords,
    };
  }

  private mergeTrendRows(
    newsnowRows: NewsnowSnapshotRow[],
    pipelineRows: PipelineBucketSummary[],
  ): MergedBucketSummary[] {
    const newsnowByBucket = new Map(
      newsnowRows.map((row) => [row.bucketStart.getTime(), row] as const),
    );
    const pipelineByBucket = new Map(
      pipelineRows.map((row) => [row.bucketStart.getTime(), row] as const),
    );
    const bucketKeys = Array.from(
      new Set([...newsnowByBucket.keys(), ...pipelineByBucket.keys()]),
    ).sort((left, right) => left - right);

    return bucketKeys.map((bucketKey) => {
      const newsnow = newsnowByBucket.get(bucketKey) ?? null;
      const pipeline = pipelineByBucket.get(bucketKey) ?? null;
      if (newsnow && !pipeline) {
        return {
          bucketStart: new Date(bucketKey),
          point: {
            bucketStart: new Date(bucketKey).toISOString(),
            indexValue: roundMetric(newsnow.indexValue),
            attentionScore: roundMetric(newsnow.attentionScore),
            breadthScore: roundMetric(newsnow.breadthScore),
            freshnessScore: roundMetric(newsnow.freshnessScore),
            sentimentPressure: roundMetric(newsnow.sentimentPressure),
            candidateCount: newsnow.candidateCount,
          },
          newsnow,
          pipeline: null,
        } satisfies MergedBucketSummary;
      }
      if (pipeline && !newsnow) {
        return {
          bucketStart: new Date(bucketKey),
          point: {
            bucketStart: new Date(bucketKey).toISOString(),
            indexValue: roundMetric(pipeline.indexValue),
            attentionScore: roundMetric(pipeline.attentionScore),
            breadthScore: roundMetric(pipeline.breadthScore),
            freshnessScore: roundMetric(pipeline.freshnessScore),
            sentimentPressure: roundMetric(pipeline.sentimentPressure),
            candidateCount: 0,
          },
          newsnow: null,
          pipeline,
        } satisfies MergedBucketSummary;
      }

      const attentionScore = mergeWeightedMetric(
        newsnow?.attentionScore ?? null,
        pipeline?.attentionScore ?? null,
        NEWSNOW_BLEND_WEIGHT,
        PIPELINE_BLEND_WEIGHT,
      );
      const breadthScore = mergeWeightedMetric(
        newsnow?.breadthScore ?? null,
        pipeline?.breadthScore ?? null,
        NEWSNOW_BLEND_WEIGHT,
        PIPELINE_BLEND_WEIGHT,
      );
      const freshnessScore = mergeWeightedMetric(
        newsnow?.freshnessScore ?? null,
        pipeline?.freshnessScore ?? null,
        NEWSNOW_BLEND_WEIGHT,
        PIPELINE_BLEND_WEIGHT,
      );
      const sentimentPressure = mergeWeightedMetric(
        newsnow?.sentimentPressure ?? null,
        pipeline?.sentimentPressure ?? null,
        newsnow?.candidateCount ?? 0,
        pipeline?.articleCount ?? 0,
      );
      const point = {
        bucketStart: new Date(bucketKey).toISOString(),
        indexValue: roundMetric(
          computeIndexValue({
            attentionScore,
            breadthScore,
            freshnessScore,
            sentimentPressure,
          }),
        ),
        attentionScore,
        breadthScore,
        freshnessScore,
        sentimentPressure,
        candidateCount: newsnow?.candidateCount ?? 0,
      } satisfies NewsnowDomesticOpinionIndexPoint;

      return {
        bucketStart: new Date(bucketKey),
        point,
        newsnow,
        pipeline,
      } satisfies MergedBucketSummary;
    });
  }

  private buildBreakdownTopKeywords(
    latest: MergedBucketSummary,
  ): NewsnowDomesticOpinionIndexBreakdownTopKeywords {
    return {
      newsnow: latest.newsnow
        ? sanitizeKeywordSummary(latest.newsnow.keywordSummary)
        : [],
      pipeline: latest.pipeline?.keywords ?? [],
    };
  }

  private mergeKeywordSummaries(values: NewsnowCandidateKeywordSummary[]) {
    const weighted = new Map<string, NewsnowCandidateKeywordSummary>();
    for (const entry of values) {
      const keyword = normalizeKeywordDisplay(entry.keyword);
      const weight = roundMetric(entry.weight);
      if (!keyword || weight <= 0) {
        continue;
      }
      const key = normalizeKeywordKey(keyword);
      const current = weighted.get(key);
      if (current) {
        current.weight = roundMetric(current.weight + weight);
        continue;
      }
      weighted.set(key, {
        keyword,
        weight,
      });
    }

    return Array.from(weighted.values())
      .sort((left, right) => {
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.keyword.localeCompare(right.keyword);
      })
      .slice(0, MAX_KEYWORDS_PER_INDEX);
  }

  private toBreakdownPoint(
    row: MergedBucketSummary,
  ): NewsnowDomesticOpinionIndexBreakdownPoint {
    return {
      bucketStart: row.bucketStart.toISOString(),
      newsnow: row.newsnow ? this.toNewsnowBreakdownSource(row.newsnow) : null,
      pipeline: row.pipeline ? this.toPipelineBreakdownSource(row.pipeline) : null,
    };
  }

  private toNewsnowBreakdownSource(
    row: NewsnowSnapshotRow,
  ): NewsnowDomesticOpinionIndexBreakdownSourcePoint {
    return {
      bucketStart: row.bucketStart.toISOString(),
      indexValue: roundMetric(row.indexValue),
      attentionScore: roundMetric(row.attentionScore),
      breadthScore: roundMetric(row.breadthScore),
      freshnessScore: roundMetric(row.freshnessScore),
      sentimentPressure: roundMetric(row.sentimentPressure),
      candidateCount: row.candidateCount,
    };
  }

  private toPipelineBreakdownSource(
    row: PipelineBucketSummary,
  ): NewsnowDomesticOpinionIndexPipelineBreakdownSourcePoint {
    return {
      bucketStart: row.bucketStart.toISOString(),
      indexValue: roundMetric(row.indexValue),
      attentionScore: roundMetric(row.attentionScore),
      breadthScore: roundMetric(row.breadthScore),
      freshnessScore: roundMetric(row.freshnessScore),
      sentimentPressure: roundMetric(row.sentimentPressure),
      articleCount: row.articleCount,
      sourceCount: row.sourceCount,
    };
  }
}
