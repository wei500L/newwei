import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';
import { z } from 'zod';

import { safeJsonParseFromText } from '../../common/llm-json';
import { CacheService } from '../cache/cache.service';
import { type CreateItemDto } from '../items/dto/create-item.dto';
import { ItemsService } from '../items/items.service';
import {
  classifySourceByLabelAndUrl,
  getDefaultNewsEventSourcePolicy,
} from '../news-events/news-event-source-classifier';
import { LiteLlmService, type LiteLlmMessage } from '../news-pipeline/litellm.service';
import type { JsonSchemaResponseFormat } from '../news-pipeline/news-prompt.builder';

import { NewsAggregatorService } from './news-aggregator.service';
import type { NewsItem, Source, SourceResponse } from './news-aggregator.types';
import type {
  NewsnowAnalyzedItem,
  NewsnowClusterInsight,
  NewsnowContentKind,
  NewsnowEventCandidate,
  NewsnowHotSignal,
  NewsnowHotSignalCluster,
  NewsnowHotSignalState,
  NewsnowHottestAnalysisResponse,
} from './newsnow-hottest-analysis.types';
import {
  buildAnalysisCacheKey,
  buildAnalysisStaleCacheKey,
  buildBridgeExternalId,
  buildHeuristicClusters,
  buildSignalKey,
  buildStateKey,
  computeCandidateScore,
  computeFreshness,
  computeHeatScore,
  normalizeTitle,
  parseHeatValue,
} from './newsnow-hottest-analysis.utils';

const logger = createLogger({ name: 'newsnow-hottest-analysis' });

const ANALYSIS_FRESH_TTL_SECONDS = 120;
const ANALYSIS_STALE_TTL_SECONDS = 600;
const ANALYSIS_LOCK_TTL_MS = 45_000;
const ANALYSIS_WAIT_TIMEOUT_MS = 120_000;
const ANALYSIS_WAIT_POLL_MS = 50;
const SIGNAL_STATE_TTL_SECONDS = 36 * 60 * 60;
const MAX_ITEMS_PER_SOURCE = 8;
const MAX_TOTAL_ITEMS = 160;
const MAX_LLM_CLUSTERS = 16;
const MAX_RETURNED_CANDIDATES = 8;
const MAX_RESOLVE_ITEMS = 96;
const AUTO_BRIDGE_MAX_ITEMS = 10;
const AUTO_BRIDGE_SOURCE_WHITELIST = new Set([
  'wallstreetcn-hot',
  'cls-hot',
  'thepaper',
  'freebuf',
  'sspai',
  'juejin',
  'ifeng',
]);

const ClusterInsightResponseSchema = z.object({
  clusters: z
    .array(
      z.object({
        clusterId: z.string().min(1),
        theme: z.string().min(1).max(80),
        label: z.string().min(1).max(80),
        summary: z.string().min(1).max(280).nullable().optional(),
        reason: z.string().max(200).nullable().optional(),
        topics: z.array(z.string().min(1).max(48)).max(8).default([]),
        entities: z
          .array(
            z.object({
              name: z.string().min(1).max(64),
              type: z.string().max(32).nullable().optional(),
            }),
          )
          .max(10)
          .default([]),
        contentKind: z
          .enum(['article', 'discussion', 'video', 'mixed', 'unknown'])
          .default('unknown'),
        bridgeEligibleSuggestion: z.boolean().default(false),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(MAX_LLM_CLUSTERS)
    .default([]),
});

const CLUSTER_INSIGHT_JSON_SCHEMA: JsonSchema7Type = zodToJsonSchema(
  ClusterInsightResponseSchema,
  { $refStrategy: 'none' },
);

const CLUSTER_INSIGHT_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'newsnow_hottest_cluster_insights_v1',
    schema: CLUSTER_INSIGHT_JSON_SCHEMA,
  },
};

interface SourceFetchResult {
  response: SourceResponse | null;
  source: Source | null;
  sourceId: string;
  error?: string;
}

interface CandidateClusterAggregate {
  cluster: NewsnowHotSignalCluster;
  insight: NewsnowClusterInsight | null;
  items: NewsnowHotSignal[];
  authority: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
}

@Injectable()
export class NewsnowHottestAnalysisService {
  private readonly inflightRefreshes = new Map<string, Promise<NewsnowHottestAnalysisResponse>>();

  constructor(
    private readonly cache: CacheService,
    private readonly aggregator: NewsAggregatorService,
    private readonly liteLlm: LiteLlmService,
    private readonly itemsService: ItemsService,
  ) {}

  async getHottestAnalysis(input: {
    orgId: string;
    userId: string;
    forceRefresh?: boolean;
    allowAutoBridge?: boolean;
  }): Promise<NewsnowHottestAnalysisResponse> {
    const freshKey = buildAnalysisCacheKey(input.orgId);
    const staleKey = buildAnalysisStaleCacheKey(input.orgId);

    if (!input.forceRefresh) {
      const cached = await this.safeGet<NewsnowHottestAnalysisResponse>(freshKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    const inflightRefresh = this.inflightRefreshes.get(freshKey);
    if (inflightRefresh) {
      return await inflightRefresh;
    }

    const refreshPromise = this.refreshAnalysisWithLock(input, freshKey, staleKey);
    this.inflightRefreshes.set(freshKey, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      if (this.inflightRefreshes.get(freshKey) === refreshPromise) {
        this.inflightRefreshes.delete(freshKey);
      }
    }
  }

  private async refreshAnalysisWithLock(
    input: {
      orgId: string;
      userId: string;
      forceRefresh?: boolean;
      allowAutoBridge?: boolean;
    },
    freshKey: string,
    staleKey: string,
  ): Promise<NewsnowHottestAnalysisResponse> {

    const refresh = async (): Promise<NewsnowHottestAnalysisResponse> => {
      const next = await this.buildAnalysis(input);
      await Promise.allSettled([
        this.cache.set(freshKey, next, ANALYSIS_FRESH_TTL_SECONDS),
        this.cache.set(staleKey, next, ANALYSIS_STALE_TTL_SECONDS),
      ]);
      return next;
    };

    try {
      const locked = await this.cache.withLock(`${freshKey}:refresh`, ANALYSIS_LOCK_TTL_MS, refresh);
      if (locked) {
        return locked;
      }

      if (!input.forceRefresh) {
        const cached = await this.safeGet<NewsnowHottestAnalysisResponse>(freshKey);
        if (cached) {
          return { ...cached, cached: true };
        }
      }

      const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(staleKey);
      if (stale && !input.forceRefresh) {
        return { ...stale, cached: true };
      }

      const waited = await this.waitForReadyAnalysis({
        freshKey,
        staleKey,
        allowStale: !input.forceRefresh,
      });
      if (waited) {
        return waited;
      }

      if (stale) {
        return { ...stale, cached: true };
      }

      throw new Error('Timed out waiting for in-flight hottest analysis refresh');
    } catch (error) {
      const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(staleKey);
      if (stale) {
        logger.warn({ error, orgId: input.orgId }, 'Serving stale hottest analysis after refresh failure');
        return { ...stale, cached: true };
      }
      throw error;
    }
  }

  private async buildAnalysis(input: {
    orgId: string;
    userId: string;
    forceRefresh?: boolean;
    allowAutoBridge?: boolean;
  }): Promise<NewsnowHottestAnalysisResponse> {
    const metadata = this.aggregator.getMetadata();
    const hottestSourceIds = (metadata.columns?.hottest?.sources ?? []).slice(0, 64);
    const fetches = await this.fetchHottestSources(hottestSourceIds, Boolean(input.forceRefresh), metadata.sources ?? {});
    const normalizedSignals = await this.buildSignals(input.orgId, fetches);
    const globalMaxHeatValue = normalizedSignals.reduce(
      (best, signal) => Math.max(best, signal.heatValue ?? 0),
      0,
    );
    const clusters = buildHeuristicClusters(normalizedSignals);
    const insightByClusterId = await this.generateClusterInsights(
      input.orgId,
      clusters.slice(0, MAX_LLM_CLUSTERS),
      normalizedSignals,
    );
    const signalByKey = new Map(normalizedSignals.map((signal) => [signal.signalKey, signal] as const));
    const clusterBySignalKey = new Map<string, CandidateClusterAggregate>();

    const clusterAggregates = clusters.map((cluster) => {
      const items = cluster.itemKeys
        .map((itemKey) => signalByKey.get(itemKey))
        .filter((value): value is NewsnowHotSignal => Boolean(value));
      const authority =
        items.length > 0
          ? items.reduce((sum, item) => sum + item.authority, 0) / items.length
          : 0;
      const heatScore = computeHeatScore({
        rank: Math.max(1, Math.round(cluster.avgRank)),
        rankCap: MAX_ITEMS_PER_SOURCE,
        heatValue: cluster.maxHeatValue,
        maxHeatValue: globalMaxHeatValue,
        sourceCount: cluster.sourceIds.length,
        authority,
      });
      const freshnessScore =
        items.length > 0
          ? Number(
              (
                items.reduce((sum, item) => sum + item.freshnessScore, 0) /
                items.length
              ).toFixed(4),
            )
          : 0;
      const insight = insightByClusterId.get(cluster.clusterId) ?? null;
      const candidateScore = computeCandidateScore({
        heatScore,
        freshnessScore,
        sourceCount: cluster.sourceIds.length,
        authority,
        confidence: insight?.confidence ?? 0.5,
      });
      const aggregate: CandidateClusterAggregate = {
        cluster,
        insight,
        items,
        authority,
        heatScore,
        freshnessScore,
        candidateScore,
      };
      items.forEach((item) => clusterBySignalKey.set(item.signalKey, aggregate));
      return aggregate;
    });

    const analysisBySignalKey = new Map<string, NewsnowAnalyzedItem>();
    const prioritizedResolvableSignals = clusterAggregates
      .flatMap((aggregate) => aggregate.items.map((item) => ({ aggregate, item })))
      .filter(({ aggregate, item }) => item.rank <= 6 || aggregate.cluster.sourceIds.length > 1)
      .sort((left, right) => {
        if (right.aggregate.candidateScore !== left.aggregate.candidateScore) {
          return right.aggregate.candidateScore - left.aggregate.candidateScore;
        }
        return left.item.rank - right.item.rank;
      });

    const guaranteedBridgeSignalKeys = new Set(
      prioritizedResolvableSignals
        .filter(({ aggregate, item }) =>
          item.rank <= 3 &&
          this.isBridgeEligible({
            signal: item,
            contentKind: this.resolveContentKind(aggregate.insight?.contentKind ?? 'unknown'),
            candidateScore: aggregate.candidateScore,
            suggested: aggregate.insight?.bridgeEligibleSuggestion ?? false,
          }),
        )
        .map(({ item }) => item.signalKey),
    );

    const signalsToResolve = Array.from(
      new Map(
        prioritizedResolvableSignals
          .filter(
            ({ item }, index) =>
              index < MAX_RESOLVE_ITEMS || guaranteedBridgeSignalKeys.has(item.signalKey),
          )
          .map(({ item }) => [item.signalKey, item] as const),
      ).values(),
    );

    const resolvedMatches = await this.resolveMatches(signalsToResolve);

    for (const signal of normalizedSignals) {
      const aggregate = clusterBySignalKey.get(signal.signalKey);
      const insight = aggregate?.insight ?? null;
      const theme = insight?.theme ?? aggregate?.cluster.representativeTitle ?? signal.title;
      const contentKind = this.resolveContentKind(insight?.contentKind ?? 'unknown');
      const matched = resolvedMatches.get(signal.signalKey);
      const bridgeEligible = this.isBridgeEligible({
        signal,
        contentKind,
        candidateScore: aggregate?.candidateScore ?? signal.freshnessScore,
        suggested: insight?.bridgeEligibleSuggestion ?? false,
      });

      analysisBySignalKey.set(signal.signalKey, {
        sourceId: signal.sourceId,
        itemId: signal.itemId,
        clusterId: aggregate?.cluster.clusterId ?? signal.signalKey,
        theme,
        candidateLabel: insight?.label ?? theme,
        candidateSummary: insight?.summary ?? null,
        reason: insight?.reason ?? null,
        topics: insight?.topics ?? [],
        entities: Array.from(
          new Set((insight?.entities ?? []).map((entity) => entity.name.trim()).filter(Boolean)),
        ),
        contentKind,
        sourceCount: aggregate?.cluster.sourceIds.length ?? 1,
        heatScore: computeHeatScore({
          rank: signal.rank,
          rankCap: MAX_ITEMS_PER_SOURCE,
          heatValue: signal.heatValue,
          maxHeatValue: globalMaxHeatValue,
          sourceCount: aggregate?.cluster.sourceIds.length ?? 1,
          authority: signal.authority,
        }),
        freshnessScore: signal.freshnessScore,
        candidateScore:
          aggregate?.candidateScore ??
          computeCandidateScore({
            heatScore: 0.5,
            freshnessScore: signal.freshnessScore,
            sourceCount: 1,
            authority: signal.authority,
            confidence: 0.5,
          }),
        isNew: signal.isNew,
        isRising: signal.isRising,
        bridgeEligible,
        bridgeStatus: matched?.itemId
          ? 'existing'
          : bridgeEligible
            ? 'eligible'
            : 'not_supported',
        ...(matched?.itemId ? { matchedItemId: matched.itemId } : {}),
        ...(matched?.eventId ? { matchedEventId: matched.eventId } : {}),
      });
    }

    if (input.allowAutoBridge) {
      await this.bridgeEligibleItems(input, normalizedSignals, analysisBySignalKey);
    }
    await this.persistSignalState(input.orgId, normalizedSignals);

    const bySource: Record<string, Record<string, NewsnowAnalyzedItem>> = {};
    normalizedSignals.forEach((signal) => {
      const next = analysisBySignalKey.get(signal.signalKey);
      if (!next) {
        return;
      }
      bySource[signal.sourceId] ??= {};
      bySource[signal.sourceId]![signal.itemId] = next;
    });

    const candidates = clusterAggregates
      .filter((aggregate) => aggregate.candidateScore >= 0.36)
      .sort((left, right) => {
        if (right.candidateScore !== left.candidateScore) {
          return right.candidateScore - left.candidateScore;
        }
        if (right.cluster.sourceIds.length !== left.cluster.sourceIds.length) {
          return right.cluster.sourceIds.length - left.cluster.sourceIds.length;
        }
        return left.cluster.avgRank - right.cluster.avgRank;
      })
      .slice(0, MAX_RETURNED_CANDIDATES)
      .map((aggregate) => this.toCandidate(aggregate, analysisBySignalKey));

    return {
      generatedAt: new Date().toISOString(),
      cached: false,
      sourcesAnalyzed: fetches.filter((entry) => Boolean(entry.response)).length,
      itemsAnalyzed: normalizedSignals.length,
      bySource,
      candidates,
      errors: fetches
        .filter((entry) => entry.error)
        .map((entry) => ({ sourceId: entry.sourceId, message: entry.error as string })),
    };
  }

  private async fetchHottestSources(
    sourceIds: string[],
    forceRefresh: boolean,
    sourcesById: Record<string, Source>,
  ): Promise<SourceFetchResult[]> {
    return this.mapWithConcurrency(sourceIds, 6, async (sourceId) => {
      try {
        const response = await this.aggregator.fetchSource(sourceId, forceRefresh);
        return { response, source: sourcesById[sourceId] ?? null, sourceId } satisfies SourceFetchResult;
      } catch (error) {
        return {
          response: null,
          source: sourcesById[sourceId] ?? null,
          sourceId,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SourceFetchResult;
      }
    });
  }

  private async buildSignals(
    orgId: string,
    fetches: SourceFetchResult[],
  ): Promise<NewsnowHotSignal[]> {
    const now = new Date();
    const policy = getDefaultNewsEventSourcePolicy();
    const pending: Array<{ signal: Omit<NewsnowHotSignal, 'state' | 'isNew' | 'isRising' | 'freshnessScore'>; stateKey: string }> = [];
    let total = 0;

    for (const fetch of fetches) {
      if (!fetch.response) {
        continue;
      }
      const sourceName = fetch.source?.name ?? fetch.sourceId;
      for (const [index, item] of fetch.response.items.slice(0, MAX_ITEMS_PER_SOURCE).entries()) {
        if (total >= MAX_TOTAL_ITEMS) {
          break;
        }
        const normalizedItem = this.toSignalItem(fetch.sourceId, sourceName, fetch.source?.home ?? null, fetch.response, item, index + 1, policy, now);
        if (!normalizedItem) {
          continue;
        }
        pending.push({
          signal: normalizedItem,
          stateKey: buildStateKey(orgId, normalizedItem.signalKey),
        });
        total += 1;
      }
      if (total >= MAX_TOTAL_ITEMS) {
        break;
      }
    }

    const states = pending.length > 0 ? await this.safeGetMany<NewsnowHotSignalState>(pending.map((entry) => entry.stateKey)) : [];

    return pending.map((entry, index) => {
      const state = states[index] ?? null;
      const freshness = computeFreshness({
        nowMs: now.getTime(),
        state,
        rank: entry.signal.rank,
      });
      return {
        ...entry.signal,
        state,
        isNew: freshness.isNew,
        isRising: freshness.isRising,
        freshnessScore: freshness.freshnessScore,
      };
    });
  }

  private toSignalItem(
    sourceId: string,
    sourceName: string,
    sourceHome: string | null,
    response: SourceResponse,
    item: NewsItem,
    rank: number,
    policy: ReturnType<typeof getDefaultNewsEventSourcePolicy>,
    capturedAt: Date,
  ): Omit<NewsnowHotSignal, 'state' | 'isNew' | 'isRising' | 'freshnessScore'> | null {
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!url || !title) {
      return null;
    }
    const authorityType = classifySourceByLabelAndUrl(sourceName, sourceHome ?? url, policy);
    const authority = authorityType === 'authoritative' ? 1 : authorityType === 'blog' ? 0.22 : 0.55;
    const hoverSummary =
      item.extra && typeof item.extra.hover === 'string' && item.extra.hover.trim().length > 0
        ? item.extra.hover.trim()
        : null;
    const heatText =
      item.extra && typeof item.extra.info === 'string' && item.extra.info.trim().length > 0
        ? item.extra.info.trim()
        : null;
    return {
      signalKey: buildSignalKey({ sourceId, title, url }),
      sourceId,
      sourceName,
      sourceHome,
      sourceUpdatedTime:
        this.toIsoDateTime(response.updatedTime),
      itemId: String(item.id),
      title,
      url,
      mobileUrl:
        typeof item.mobileUrl === 'string' && item.mobileUrl.trim().length > 0
          ? item.mobileUrl.trim()
          : null,
      hoverSummary,
      heatText,
      heatValue: parseHeatValue(heatText),
      rank,
      capturedAt: capturedAt.toISOString(),
      normalizedTitle: normalizeTitle(title),
      authority,
    };
  }

  private async generateClusterInsights(
    orgId: string,
    clusters: NewsnowHotSignalCluster[],
    signals: NewsnowHotSignal[],
  ): Promise<Map<string, NewsnowClusterInsight>> {
    if (clusters.length === 0) {
      return new Map();
    }
    const signalByKey = new Map(signals.map((signal) => [signal.signalKey, signal] as const));
    const clusterPayload = clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      sourceCount: cluster.sourceIds.length,
      representativeTitle: cluster.representativeTitle,
      items: cluster.itemKeys
        .map((itemKey) => signalByKey.get(itemKey))
        .filter((value): value is NewsnowHotSignal => Boolean(value))
        .sort((left, right) => left.rank - right.rank)
        .slice(0, 5)
        .map((item) => ({
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          rank: item.rank,
          title: item.title,
          heatText: item.heatText,
          hoverSummary: item.hoverSummary,
        })),
    }));

    const messages: LiteLlmMessage[] = [
      {
        role: 'system',
        content: [
          'You analyze cross-platform trending-topic clusters from hot-ranking boards.',
          'Return strict JSON only.',
          'For each cluster, normalize the core theme, concise candidate label, short summary, entities, and a coarse content kind.',
          'contentKind should be article, discussion, video, mixed, or unknown.',
          'bridgeEligibleSuggestion should be true only when the cluster likely points to a crawlable article/news report rather than pure discussion, meme, or short video chatter.',
          'Prefer Chinese output when the titles are Chinese.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ clusters: clusterPayload }),
      },
    ];

    try {
      const response = await this.liteLlm.acompletion({
        orgId,
        messages,
        temperature: 0.15,
        top_p: 0.9,
        max_tokens: 1800,
        response_format: CLUSTER_INSIGHT_RESPONSE_FORMAT,
        metadata: {
          feature: 'newsnow_hottest_cluster_analysis',
          clusters: clusterPayload.length,
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return new Map();
      }
      const parsed = safeJsonParseFromText<unknown>(content);
      if (!parsed) {
        logger.warn({ preview: content.slice(0, 320) }, 'Failed to parse hottest cluster insights JSON');
        return new Map();
      }
      const normalized = ClusterInsightResponseSchema.parse(parsed);
      return new Map(
        normalized.clusters.map((cluster) => [
          cluster.clusterId,
          {
            clusterId: cluster.clusterId,
            theme: cluster.theme,
            label: cluster.label,
            summary: cluster.summary ?? null,
            reason: cluster.reason ?? null,
            topics: cluster.topics,
            entities: cluster.entities.map((entity) => ({
              name: entity.name,
              type: entity.type ?? null,
            })),
            contentKind: cluster.contentKind,
            bridgeEligibleSuggestion: cluster.bridgeEligibleSuggestion,
            confidence: cluster.confidence,
          } satisfies NewsnowClusterInsight,
        ]),
      );
    } catch (error) {
      logger.warn({ error, orgId }, 'LLM hottest cluster analysis failed; falling back to heuristic labels');
      return new Map();
    }
  }

  private async resolveMatches(
    signals: NewsnowHotSignal[],
  ): Promise<Map<string, { itemId?: string; eventId?: string }>> {
    const results = await this.mapWithConcurrency(signals, 6, async (signal) => {
      try {
        const resolved = await this.aggregator.resolveByUrl(signal.url);
        return [signal.signalKey, resolved] as const;
      } catch {
        return [signal.signalKey, { matched: false }] as const;
      }
    });

    return new Map(
      results.map(([signalKey, resolved]) => [
        signalKey,
        {
          ...(resolved.matched && resolved.itemId ? { itemId: resolved.itemId } : {}),
          ...(resolved.matched && resolved.eventId ? { eventId: resolved.eventId } : {}),
        },
      ]),
    );
  }

  private isBridgeEligible(input: {
    signal: NewsnowHotSignal;
    contentKind: NewsnowContentKind;
    candidateScore: number;
    suggested: boolean;
  }): boolean {
    if (!AUTO_BRIDGE_SOURCE_WHITELIST.has(input.signal.sourceId)) {
      return false;
    }
    if (input.contentKind === 'discussion' || input.contentKind === 'video') {
      return false;
    }
    if (!input.signal.url.startsWith('http://') && !input.signal.url.startsWith('https://')) {
      return false;
    }
    return input.suggested || input.candidateScore >= 0.52;
  }

  private async bridgeEligibleItems(
    input: { orgId: string; userId: string },
    signals: NewsnowHotSignal[],
    analysisBySignalKey: Map<string, NewsnowAnalyzedItem>,
  ) {
    const bridgeTargets = signals
      .map((signal) => ({ signal, analysis: analysisBySignalKey.get(signal.signalKey) }))
      .filter(
        (entry): entry is { signal: NewsnowHotSignal; analysis: NewsnowAnalyzedItem } =>
          Boolean(entry.analysis),
      )
      .filter(
        ({ signal, analysis }) =>
          analysis.bridgeEligible &&
          !analysis.matchedItemId &&
          analysis.candidateScore >= 0.52 &&
          signal.rank <= 3,
      )
      .sort((left, right) => {
        if (right.analysis.candidateScore !== left.analysis.candidateScore) {
          return right.analysis.candidateScore - left.analysis.candidateScore;
        }
        return left.signal.rank - right.signal.rank;
      })
      .slice(0, AUTO_BRIDGE_MAX_ITEMS);

    await this.mapWithConcurrency(bridgeTargets, 3, async ({ signal, analysis }) => {
      const dto: CreateItemDto = {
        externalId: buildBridgeExternalId(signal.sourceId, signal.url),
        name: `${signal.sourceName}: ${signal.title}`.slice(0, 255),
        payload: {
          url: signal.url,
          sourceName: signal.sourceName,
          tags: ['newsnow', 'hottest', signal.sourceId],
          summaryHints: [analysis.theme, analysis.candidateLabel]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .slice(0, 4),
          metadata: {
            newsnow: {
              sourceId: signal.sourceId,
              itemId: signal.itemId,
              rank: signal.rank,
              heatText: signal.heatText,
              capturedAt: signal.capturedAt,
              sourceUpdatedTime: signal.sourceUpdatedTime,
            },
            hottestAnalysis: {
              theme: analysis.theme,
              candidateLabel: analysis.candidateLabel,
              candidateScore: analysis.candidateScore,
              freshnessScore: analysis.freshnessScore,
            },
          },
          forceRefresh: false,
        },
      };

      try {
        const created = await this.itemsService.create(input.orgId, input.userId, dto);
        if (created?.id) {
          analysis.matchedItemId = created.id;
          analysis.bridgeStatus = 'queued';
        }
      } catch (error) {
        logger.warn(
          { error, sourceId: signal.sourceId, url: signal.url },
          'Failed to auto-bridge hottest signal into items',
        );
      }
    });
  }

  private async persistSignalState(orgId: string, signals: NewsnowHotSignal[]) {
    await Promise.allSettled(
      signals.map((signal) =>
        this.cache.set(
          buildStateKey(orgId, signal.signalKey),
          {
            firstSeenAt: signal.state?.firstSeenAt ?? signal.capturedAt,
            lastSeenAt: signal.capturedAt,
            lastRank: signal.rank,
          } satisfies NewsnowHotSignalState,
          SIGNAL_STATE_TTL_SECONDS,
        ),
      ),
    );
  }

  private toCandidate(
    aggregate: CandidateClusterAggregate,
    analysisBySignalKey: Map<string, NewsnowAnalyzedItem>,
  ): NewsnowEventCandidate {
    const analysisItems = aggregate.items
      .map((signal) => ({ signal, analysis: analysisBySignalKey.get(signal.signalKey) }))
      .filter(
        (entry): entry is { signal: NewsnowHotSignal; analysis: NewsnowAnalyzedItem } => Boolean(entry.analysis),
      )
      .sort((left, right) => left.signal.rank - right.signal.rank);
    const insight = aggregate.insight;
    return {
      candidateId: aggregate.cluster.clusterId,
      label: insight?.label ?? aggregate.cluster.representativeTitle,
      summary: insight?.summary ?? null,
      reason: insight?.reason ?? null,
      themes: Array.from(
        new Set([
          ...(insight?.theme ? [insight.theme] : []),
          ...(insight?.topics ?? []),
        ]),
      ).slice(0, 4),
      entities: Array.from(
        new Set((insight?.entities ?? []).map((entity) => entity.name.trim()).filter(Boolean)),
      ).slice(0, 8),
      sourceIds: aggregate.cluster.sourceIds,
      sourceCount: aggregate.cluster.sourceIds.length,
      itemCount: aggregate.items.length,
      heatScore: aggregate.heatScore,
      freshnessScore: aggregate.freshnessScore,
      candidateScore: aggregate.candidateScore,
      itemRefs: analysisItems.slice(0, 8).map(({ signal, analysis }) => ({
        sourceId: signal.sourceId,
        itemId: signal.itemId,
        title: signal.title,
        ...(analysis.matchedItemId ? { matchedItemId: analysis.matchedItemId } : {}),
        ...(analysis.matchedEventId ? { matchedEventId: analysis.matchedEventId } : {}),
      })),
    };
  }

  private resolveContentKind(value: string): NewsnowContentKind {
    return value === 'article' || value === 'discussion' || value === 'video' || value === 'mixed'
      ? value
      : 'unknown';
  }

  private toIsoDateTime(value: unknown): string | null {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      !(value instanceof Date)
    ) {
      return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
  }

  private async safeGet<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (error) {
      logger.warn({ error, key }, 'Cache read failed for hottest analysis');
      return null;
    }
  }

  private async safeGetMany<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    try {
      return await this.cache.getMany<T>(keys);
    } catch (error) {
      logger.warn({ error, count: keys.length }, 'Cache batch read failed for hottest analysis');
      return keys.map(() => null);
    }
  }

  private async waitForReadyAnalysis(input: {
    freshKey: string;
    staleKey: string;
    allowStale: boolean;
  }): Promise<NewsnowHottestAnalysisResponse | null> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < ANALYSIS_WAIT_TIMEOUT_MS) {
      const fresh = await this.safeGet<NewsnowHottestAnalysisResponse>(input.freshKey);
      if (fresh) {
        return { ...fresh, cached: true };
      }

      if (input.allowStale) {
        const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(input.staleKey);
        if (stale) {
          return { ...stale, cached: true };
        }
      }

      await this.delay(ANALYSIS_WAIT_POLL_MS);
    }

    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (values.length === 0) {
      return [];
    }
    const results = new Array<R>(values.length);
    const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
    let cursor = 0;

    await Promise.all(
      Array.from({ length: safeConcurrency }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= values.length) {
            return;
          }
          results[index] = await worker(values[index] as T, index);
        }
      }),
    );

    return results;
  }
}
