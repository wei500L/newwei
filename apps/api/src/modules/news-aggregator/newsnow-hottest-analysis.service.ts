import { buildComparableUrlVariants } from '@modular/mongo';
import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';

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
import { NewsnowDataState } from './news-aggregator.types';
import type { NewsItem, Source, SourceResponse } from './news-aggregator.types';
import {
  NewsnowDomesticOpinionIndexService,
  type NewsnowCandidatePersistenceInput,
} from './newsnow-domestic-opinion-index.service';
import { NewsnowHottestAnalysisEmptyReason } from './newsnow-hottest-analysis.types';
import type {
  NewsnowAnalyzedItem,
  NewsnowClusterInsight,
  NewsnowContentKind,
  NewsnowEventCandidate,
  NewsnowHotSignal,
  NewsnowHotSignalCluster,
  NewsnowHotSignalSeed,
  NewsnowHotSignalState,
  NewsnowHottestAnalysisDiagnostics,
  NewsnowHottestAnalysisResponse,
  NewsnowHottestGlobalSnapshot,
} from './newsnow-hottest-analysis.types';
import {
  buildAnalysisCacheKey,
  buildAnalysisStaleCacheKey,
  buildBridgeExternalId,
  buildGlobalInputSignature,
  buildGlobalSignatureCacheKey,
  buildGlobalSnapshotCacheKey,
  buildGlobalSnapshotStaleCacheKey,
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
const GLOBAL_SNAPSHOT_FRESH_TTL_SECONDS = 2 * 60 * 60;
const GLOBAL_SNAPSHOT_STALE_TTL_SECONDS = 24 * 60 * 60;
const GLOBAL_SNAPSHOT_LOCK_TTL_MS = 45_000;
const GLOBAL_SNAPSHOT_WAIT_TIMEOUT_MS = 120_000;
const GLOBAL_SNAPSHOT_WAIT_POLL_MS = 50;
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

interface HottestMetadataContext {
  hottestSourceIds: string[];
  sourcesById: Record<string, Source>;
  totalDomesticSourceCount: number;
}

function resolveHottestAnalysisEmptyReason(input: {
  candidates: NewsnowEventCandidate[];
  diagnostics: NewsnowHottestAnalysisDiagnostics;
  itemsAnalyzed: number;
}): NewsnowHottestAnalysisEmptyReason | null {
  if (input.candidates.length > 0) {
    return null;
  }
  if (input.diagnostics.sourcesRequested === 0) {
    return NewsnowHottestAnalysisEmptyReason.NoHottestSourcesConfigured;
  }
  if (
    input.diagnostics.sourcesSucceeded === 0 &&
    input.diagnostics.sourcesFailed > 0
  ) {
    return NewsnowHottestAnalysisEmptyReason.AllSourcesFailed;
  }
  if (input.diagnostics.sourceItemsFetched === 0) {
    return NewsnowHottestAnalysisEmptyReason.NoSourceItems;
  }
  if (input.itemsAnalyzed === 0) {
    return NewsnowHottestAnalysisEmptyReason.NoHotSignals;
  }
  return NewsnowHottestAnalysisEmptyReason.NoCandidates;
}

@Injectable()
export class NewsnowHottestAnalysisService {
  private readonly inflightRefreshes = new Map<string, Promise<NewsnowHottestAnalysisResponse>>();
  private readonly inflightGlobalSnapshots = new Map<
    string,
    Promise<NewsnowHottestGlobalSnapshot>
  >();

  constructor(
    private readonly cache: CacheService,
    private readonly aggregator: NewsAggregatorService,
    private readonly liteLlm: LiteLlmService,
    private readonly itemsService: ItemsService,
    private readonly domesticOpinionIndexService: NewsnowDomesticOpinionIndexService,
  ) {}

  async getHottestAnalysis(input: {
    orgId: string;
    userId?: string;
    forceRefresh?: boolean;
    allowAutoBridge?: boolean;
  }): Promise<NewsnowHottestAnalysisResponse> {
    const freshKey = buildAnalysisCacheKey(input.orgId);
    const staleKey = buildAnalysisStaleCacheKey(input.orgId);

    if (!input.forceRefresh) {
      const cached = await this.safeGet<NewsnowHottestAnalysisResponse>(freshKey);
      if (cached) {
        return this.normalizeAnalysisResponse({ ...cached, cached: true });
      }
    }

    return await this.runOrgRefreshWithInflight(
      freshKey,
      this.refreshAnalysisWithLock(input, freshKey, staleKey),
    );
  }

  async refreshAnalysisForOrg(orgId: string): Promise<NewsnowHottestAnalysisResponse> {
    return await this.refreshProjectionForOrg({
      orgId,
      allowAutoBridge: false,
    });
  }

  async refreshProjectionForOrg(input: {
    orgId: string;
    userId?: string;
    allowAutoBridge?: boolean;
    globalSnapshot?: NewsnowHottestGlobalSnapshot;
  }): Promise<NewsnowHottestAnalysisResponse> {
    const freshKey = buildAnalysisCacheKey(input.orgId);
    const staleKey = buildAnalysisStaleCacheKey(input.orgId);

    return await this.runOrgRefreshWithInflight(
      freshKey,
      this.refreshAnalysisWithLock(
        {
          ...input,
          forceRefresh: true,
        },
        freshKey,
        staleKey,
      ),
    );
  }

  async ensureGlobalSnapshot(input?: {
    orgId?: string;
  }): Promise<NewsnowHottestGlobalSnapshot> {
    const context = this.getHottestMetadataContext();
    const fetches = await this.fetchHottestSources(
      context.hottestSourceIds,
      false,
      context.sourcesById,
    );
    const signature = this.buildCurrentGlobalSignature(fetches);
    const freshKey = buildGlobalSnapshotCacheKey();
    const staleKey = buildGlobalSnapshotStaleCacheKey();
    const signatureKey = buildGlobalSignatureCacheKey();

    const [fresh, stale, cachedSignature] = await Promise.all([
      this.safeGet<NewsnowHottestGlobalSnapshot>(freshKey),
      this.safeGet<NewsnowHottestGlobalSnapshot>(staleKey),
      this.safeGet<string>(signatureKey),
    ]);

    if (fresh?.signature === signature) {
      return fresh;
    }

    if (cachedSignature === signature && stale?.signature === signature) {
      return stale;
    }

    return await this.runGlobalSnapshotWithInflight(
      signature,
      this.refreshGlobalSnapshotWithLock(
        {
          orgId: input?.orgId,
          context,
          fetches,
          signature,
        },
        freshKey,
        staleKey,
        signatureKey,
      ),
    );
  }

  private async runOrgRefreshWithInflight(
    freshKey: string,
    refreshPromiseFactory: () => Promise<NewsnowHottestAnalysisResponse>,
  ): Promise<NewsnowHottestAnalysisResponse> {
    const inflightRefresh = this.inflightRefreshes.get(freshKey);
    if (inflightRefresh) {
      return await inflightRefresh;
    }

    const refreshPromise = refreshPromiseFactory();
    this.inflightRefreshes.set(freshKey, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      if (this.inflightRefreshes.get(freshKey) === refreshPromise) {
        this.inflightRefreshes.delete(freshKey);
      }
    }
  }

  private async runGlobalSnapshotWithInflight(
    signature: string,
    refreshPromiseFactory: () => Promise<NewsnowHottestGlobalSnapshot>,
  ): Promise<NewsnowHottestGlobalSnapshot> {
    const inflightRefresh = this.inflightGlobalSnapshots.get(signature);
    if (inflightRefresh) {
      return await inflightRefresh;
    }

    const refreshPromise = refreshPromiseFactory();
    this.inflightGlobalSnapshots.set(signature, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      if (this.inflightGlobalSnapshots.get(signature) === refreshPromise) {
        this.inflightGlobalSnapshots.delete(signature);
      }
    }
  }

  private refreshAnalysisWithLock(
    input: {
      orgId: string;
      userId?: string;
      forceRefresh?: boolean;
      allowAutoBridge?: boolean;
      globalSnapshot?: NewsnowHottestGlobalSnapshot;
    },
    freshKey: string,
    staleKey: string,
  ): () => Promise<NewsnowHottestAnalysisResponse> {
    return async () => {
      const refresh = async (): Promise<NewsnowHottestAnalysisResponse> => {
        const globalSnapshot =
          input.globalSnapshot ??
          (await this.ensureGlobalSnapshot({ orgId: input.orgId }));
        const next = await this.buildAnalysisFromGlobalSnapshot({
          orgId: input.orgId,
          userId: input.userId,
          allowAutoBridge: input.allowAutoBridge,
          globalSnapshot,
        });
        await Promise.allSettled([
          this.cache.set(freshKey, next, ANALYSIS_FRESH_TTL_SECONDS),
          this.cache.set(staleKey, next, ANALYSIS_STALE_TTL_SECONDS),
        ]);
        return next;
      };

      try {
        const locked = await this.cache.withLock(
          `${freshKey}:refresh`,
          ANALYSIS_LOCK_TTL_MS,
          refresh,
        );
        if (locked) {
          return locked;
        }

        if (!input.forceRefresh) {
          const cached = await this.safeGet<NewsnowHottestAnalysisResponse>(freshKey);
          if (cached) {
            return this.normalizeAnalysisResponse({ ...cached, cached: true });
          }
        }

        const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(staleKey);
        if (stale && !input.forceRefresh) {
          return this.normalizeAnalysisResponse({ ...stale, cached: true });
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
          return this.normalizeAnalysisResponse({ ...stale, cached: true });
        }

        throw new Error('Timed out waiting for in-flight hottest analysis refresh');
      } catch (error) {
        const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(staleKey);
        if (stale) {
          logger.warn({ error, orgId: input.orgId }, 'Serving stale hottest analysis after refresh failure');
          return this.normalizeAnalysisResponse({ ...stale, cached: true });
        }
        throw error;
      }
    };
  }

  private refreshGlobalSnapshotWithLock(
    input: {
      orgId?: string;
      context: HottestMetadataContext;
      fetches: SourceFetchResult[];
      signature: string;
    },
    freshKey: string,
    staleKey: string,
    signatureKey: string,
  ): () => Promise<NewsnowHottestGlobalSnapshot> {
    return async () => {
      const refresh = async (): Promise<NewsnowHottestGlobalSnapshot> => {
        const next = await this.buildGlobalSnapshot(input);
        await Promise.allSettled([
          this.cache.set(freshKey, next, GLOBAL_SNAPSHOT_FRESH_TTL_SECONDS),
          this.cache.set(staleKey, next, GLOBAL_SNAPSHOT_STALE_TTL_SECONDS),
          this.cache.set(signatureKey, next.signature, GLOBAL_SNAPSHOT_STALE_TTL_SECONDS),
        ]);
        return next;
      };

      try {
        const locked = await this.cache.withLock(
          `${freshKey}:refresh`,
          GLOBAL_SNAPSHOT_LOCK_TTL_MS,
          refresh,
        );
        if (locked) {
          return locked;
        }

        const fresh = await this.safeGet<NewsnowHottestGlobalSnapshot>(freshKey);
        if (fresh?.signature === input.signature) {
          return fresh;
        }

        const waited = await this.waitForReadyGlobalSnapshot({
          freshKey,
          staleKey,
          signature: input.signature,
        });
        if (waited) {
          return waited;
        }

        const stale = await this.safeGet<NewsnowHottestGlobalSnapshot>(staleKey);
        if (stale) {
          return stale;
        }

        throw new Error('Timed out waiting for in-flight hottest global snapshot refresh');
      } catch (error) {
        const stale = await this.safeGet<NewsnowHottestGlobalSnapshot>(staleKey);
        if (stale) {
          logger.warn({ error }, 'Serving stale hottest global snapshot after refresh failure');
          return stale;
        }
        throw error;
      }
    };
  }

  private async buildGlobalSnapshot(input: {
    orgId?: string;
    context: HottestMetadataContext;
    fetches: SourceFetchResult[];
    signature: string;
  }): Promise<NewsnowHottestGlobalSnapshot> {
    const generatedAt = new Date();
    const signalSeeds = this.buildSignalSeeds(input.fetches);
    const globalMaxHeatValue = signalSeeds.reduce(
      (best, signal) => Math.max(best, signal.heatValue ?? 0),
      0,
    );
    const clusters = buildHeuristicClusters(signalSeeds);
    const insightByClusterId = await this.generateClusterInsights(
      input.orgId,
      clusters.slice(0, MAX_LLM_CLUSTERS),
      signalSeeds,
    );

    return {
      signature: input.signature,
      generatedAt: generatedAt.toISOString(),
      diagnostics: this.buildDiagnostics(input.fetches),
      errors: input.fetches
        .filter((entry) => entry.error)
        .map((entry) => ({
          sourceId: entry.sourceId,
          message: entry.error as string,
        })),
      totalDomesticSourceCount: input.context.totalDomesticSourceCount,
      globalMaxHeatValue,
      signalSeeds,
      clusters,
      clusterInsights: Array.from(insightByClusterId.values()),
    };
  }

  private async buildAnalysisFromGlobalSnapshot(input: {
    orgId: string;
    userId?: string;
    allowAutoBridge?: boolean;
    globalSnapshot: NewsnowHottestGlobalSnapshot;
  }): Promise<NewsnowHottestAnalysisResponse> {
    const generatedAt = new Date();
    const metadataContext = this.getHottestMetadataContext();
    const normalizedSignals = await this.buildSignalsFromSeeds(
      input.orgId,
      input.globalSnapshot.signalSeeds,
      generatedAt,
    );
    const insightByClusterId = new Map(
      input.globalSnapshot.clusterInsights.map((insight) => [insight.clusterId, insight] as const),
    );
    const { clusterAggregates, clusterBySignalKey } = this.buildClusterAggregates({
      signals: normalizedSignals,
      clusters: input.globalSnapshot.clusters,
      insightByClusterId,
      globalMaxHeatValue: input.globalSnapshot.globalMaxHeatValue,
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
          maxHeatValue: input.globalSnapshot.globalMaxHeatValue,
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

    if (input.allowAutoBridge && input.userId) {
      await this.bridgeEligibleItems(
        { orgId: input.orgId, userId: input.userId },
        normalizedSignals,
        analysisBySignalKey,
      );
    }

    await this.persistSignalState(input.orgId, normalizedSignals);
    await this.persistDomesticOpinionSnapshotsBestEffort({
      orgId: input.orgId,
      generatedAt,
      totalDomesticSourceCount: input.globalSnapshot.totalDomesticSourceCount,
      candidates: clusterAggregates.map((aggregate) =>
        this.toCandidatePersistenceInput(
          aggregate,
          analysisBySignalKey,
          metadataContext.sourcesById,
        ),
      ),
    });

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
    const emptyReason = resolveHottestAnalysisEmptyReason({
      candidates,
      diagnostics: input.globalSnapshot.diagnostics,
      itemsAnalyzed: normalizedSignals.length,
    });

    return {
      generatedAt: generatedAt.toISOString(),
      cached: false,
      dataState:
        candidates.length > 0 ? NewsnowDataState.Ready : NewsnowDataState.Empty,
      emptyReason,
      diagnostics: input.globalSnapshot.diagnostics,
      sourcesAnalyzed: input.globalSnapshot.diagnostics.sourcesSucceeded,
      itemsAnalyzed: normalizedSignals.length,
      bySource,
      candidates,
      errors: input.globalSnapshot.errors,
    };
  }

  private buildClusterAggregates(input: {
    signals: NewsnowHotSignal[];
    clusters: NewsnowHotSignalCluster[];
    insightByClusterId: Map<string, NewsnowClusterInsight>;
    globalMaxHeatValue: number;
  }): {
    clusterAggregates: CandidateClusterAggregate[];
    clusterBySignalKey: Map<string, CandidateClusterAggregate>;
  } {
    const signalByKey = new Map(
      input.signals.map((signal) => [signal.signalKey, signal] as const),
    );
    const clusterBySignalKey = new Map<string, CandidateClusterAggregate>();

    const clusterAggregates = input.clusters.map((cluster) => {
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
        maxHeatValue: input.globalMaxHeatValue,
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
      const insight = input.insightByClusterId.get(cluster.clusterId) ?? null;
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

    return { clusterAggregates, clusterBySignalKey };
  }

  private async fetchHottestSources(
    sourceIds: string[],
    forceRefresh: boolean,
    sourcesById: Record<string, Source>,
  ): Promise<SourceFetchResult[]> {
    return this.mapWithConcurrency(sourceIds, 6, async (sourceId) => {
      try {
        const response = await this.aggregator.fetchSource(sourceId, forceRefresh);
        return {
          response,
          source: sourcesById[sourceId] ?? null,
          sourceId,
        } satisfies SourceFetchResult;
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

  private buildSignalSeeds(fetches: SourceFetchResult[]): NewsnowHotSignalSeed[] {
    const policy = getDefaultNewsEventSourcePolicy();
    const pending: NewsnowHotSignalSeed[] = [];
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
        const normalizedItem = this.toSignalSeed(
          fetch.sourceId,
          sourceName,
          fetch.source?.home ?? null,
          fetch.response,
          item,
          index + 1,
          policy,
        );
        if (!normalizedItem) {
          continue;
        }
        pending.push(normalizedItem);
        total += 1;
      }
      if (total >= MAX_TOTAL_ITEMS) {
        break;
      }
    }

    return pending;
  }

  private async buildSignalsFromSeeds(
    orgId: string,
    seeds: NewsnowHotSignalSeed[],
    capturedAt: Date,
  ): Promise<NewsnowHotSignal[]> {
    const pending = seeds.map((seed) => ({
      seed,
      stateKey: buildStateKey(orgId, seed.signalKey),
    }));
    const states =
      pending.length > 0
        ? await this.safeGetMany<NewsnowHotSignalState>(
            pending.map((entry) => entry.stateKey),
          )
        : [];

    return pending.map((entry, index) => {
      const state = states[index] ?? null;
      const freshness = computeFreshness({
        nowMs: capturedAt.getTime(),
        state,
        rank: entry.seed.rank,
      });
      return {
        ...entry.seed,
        capturedAt: capturedAt.toISOString(),
        state,
        isNew: freshness.isNew,
        isRising: freshness.isRising,
        freshnessScore: freshness.freshnessScore,
      };
    });
  }

  private toSignalSeed(
    sourceId: string,
    sourceName: string,
    sourceHome: string | null,
    response: SourceResponse,
    item: NewsItem,
    rank: number,
    policy: ReturnType<typeof getDefaultNewsEventSourcePolicy>,
  ): NewsnowHotSignalSeed | null {
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!url || !title) {
      return null;
    }
    const authorityType = classifySourceByLabelAndUrl(sourceName, sourceHome ?? url, policy);
    const authority =
      authorityType === 'authoritative' ? 1 : authorityType === 'blog' ? 0.22 : 0.55;
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
      sourceUpdatedTime: this.toIsoDateTime(response.updatedTime),
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
      normalizedTitle: normalizeTitle(title),
      authority,
    };
  }

  private async generateClusterInsights(
    orgId: string | undefined,
    clusters: NewsnowHotSignalCluster[],
    signals: NewsnowHotSignalSeed[],
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
        .filter((value): value is NewsnowHotSignalSeed => Boolean(value))
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
    const buildResolveKey = (url: string) => buildComparableUrlVariants(url)?.full ?? url.trim();
    const uniqueSignals = new Map<string, NewsnowHotSignal>();

    for (const signal of signals) {
      const resolveKey = buildResolveKey(signal.url);
      if (!uniqueSignals.has(resolveKey)) {
        uniqueSignals.set(resolveKey, signal);
      }
    }

    const results = await this.mapWithConcurrency(Array.from(uniqueSignals.values()), 6, async (signal) => {
      try {
        const resolved = await this.aggregator.resolveByUrl(signal.url);
        return [buildResolveKey(signal.url), resolved] as const;
      } catch {
        return [buildResolveKey(signal.url), { matched: false }] as const;
      }
    });

    const resolvedByKey = new Map(results);
    return new Map(
      signals.map((signal) => {
        const resolveKey = buildResolveKey(signal.url);
        const resolved = resolvedByKey.get(resolveKey) ?? { matched: false };
        return [
          signal.signalKey,
          {
            ...(resolved.matched && resolved.itemId ? { itemId: resolved.itemId } : {}),
            ...(resolved.matched && resolved.eventId ? { eventId: resolved.eventId } : {}),
          },
        ] as const;
      }),
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

  private normalizeAnalysisResponse(
    response: NewsnowHottestAnalysisResponse,
  ): NewsnowHottestAnalysisResponse {
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const errors = Array.isArray(response.errors) ? response.errors : [];
    const diagnostics: NewsnowHottestAnalysisDiagnostics = response.diagnostics ?? {
      sourcesRequested: Math.max(response.sourcesAnalyzed, 0) + errors.length,
      sourcesSucceeded: Math.max(response.sourcesAnalyzed, 0),
      sourcesFailed: errors.length,
      sourceItemsFetched: Math.max(response.itemsAnalyzed, 0),
    };
    const dataState =
      response.dataState ??
      (candidates.length > 0 ? NewsnowDataState.Ready : NewsnowDataState.Empty);
    const emptyReason =
      response.emptyReason ??
      (dataState === NewsnowDataState.Empty
        ? resolveHottestAnalysisEmptyReason({
            candidates,
            diagnostics,
            itemsAnalyzed: response.itemsAnalyzed,
          })
        : null);

    return {
      ...response,
      dataState,
      emptyReason,
      diagnostics,
      candidates,
      errors,
    };
  }

  private async persistDomesticOpinionSnapshotsBestEffort(input: {
    orgId: string;
    generatedAt: Date;
    totalDomesticSourceCount: number;
    candidates: NewsnowCandidatePersistenceInput[];
  }) {
    try {
      await this.domesticOpinionIndexService.persistSnapshots(input);
    } catch (error) {
      logger.warn(
        { error, orgId: input.orgId },
        'Failed to persist NewsNow domestic opinion snapshots',
      );
    }
  }

  private toCandidate(
    aggregate: CandidateClusterAggregate,
    analysisBySignalKey: Map<string, NewsnowAnalyzedItem>,
  ): NewsnowEventCandidate {
    const analysisItems = aggregate.items
      .map((signal) => ({ signal, analysis: analysisBySignalKey.get(signal.signalKey) }))
      .filter(
        (entry): entry is { signal: NewsnowHotSignal; analysis: NewsnowAnalyzedItem } =>
          Boolean(entry.analysis),
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

  private toCandidatePersistenceInput(
    aggregate: CandidateClusterAggregate,
    analysisBySignalKey: Map<string, NewsnowAnalyzedItem>,
    sourcesById: Record<string, Source>,
  ): NewsnowCandidatePersistenceInput {
    const insight = aggregate.insight;
    const domesticItems = aggregate.items.filter(
      (item) => sourcesById[item.sourceId]?.column === 'china',
    );
    const domesticSourceIds = Array.from(new Set(domesticItems.map((item) => item.sourceId)));
    const matchedItemIds = Array.from(
      new Set(
        aggregate.items
          .map((item) => analysisBySignalKey.get(item.signalKey)?.matchedItemId ?? '')
          .filter((itemId): itemId is string => itemId.trim().length > 0),
      ),
    );

    return {
      candidateHash: aggregate.cluster.clusterId,
      label: insight?.label ?? aggregate.cluster.representativeTitle,
      summary: insight?.summary ?? null,
      representativeTitle: aggregate.cluster.representativeTitle,
      themes: Array.from(
        new Set([
          ...(insight?.theme ? [insight.theme] : []),
          ...(insight?.topics ?? []),
        ]),
      ).slice(0, 8),
      topics: insight?.topics ?? [],
      entities: Array.from(
        new Set((insight?.entities ?? []).map((entity) => entity.name.trim()).filter(Boolean)),
      ).slice(0, 10),
      sourceIds: aggregate.cluster.sourceIds,
      domesticSourceIds,
      sourceCount: aggregate.cluster.sourceIds.length,
      itemCount: aggregate.items.length,
      heatScore: aggregate.heatScore,
      freshnessScore: aggregate.freshnessScore,
      candidateScore: aggregate.candidateScore,
      authorityScore: aggregate.authority,
      domesticSourceCount: domesticSourceIds.length,
      domesticItemCount: domesticItems.length,
      matchedItemIds,
    };
  }

  private resolveContentKind(value: string): NewsnowContentKind {
    return value === 'article' || value === 'discussion' || value === 'video' || value === 'mixed'
      ? value
      : 'unknown';
  }

  private getHottestMetadataContext(): HottestMetadataContext {
    const metadata = this.aggregator.getMetadata();
    const hottestSourceIds = (metadata.columns?.hottest?.sources ?? []).slice(0, 64);
    const sourcesById = metadata.sources ?? {};
    return {
      hottestSourceIds,
      sourcesById,
      totalDomesticSourceCount: hottestSourceIds.filter(
        (sourceId) => sourcesById[sourceId]?.column === 'china',
      ).length,
    };
  }

  private buildDiagnostics(
    fetches: SourceFetchResult[],
  ): NewsnowHottestAnalysisDiagnostics {
    return {
      sourcesRequested: fetches.length,
      sourcesSucceeded: fetches.filter((entry) => Boolean(entry.response)).length,
      sourcesFailed: fetches.filter((entry) => Boolean(entry.error)).length,
      sourceItemsFetched: fetches.reduce(
        (total, entry) => total + (entry.response?.items.length ?? 0),
        0,
      ),
    };
  }

  private buildCurrentGlobalSignature(fetches: SourceFetchResult[]): string {
    return buildGlobalInputSignature({
      entries: fetches.map((fetch) => ({
        sourceId: fetch.sourceId,
        failed: !fetch.response,
        items: (fetch.response?.items ?? []).slice(0, MAX_ITEMS_PER_SOURCE).map((item, index) => ({
          id: String(item.id),
          title: typeof item.title === 'string' ? item.title : '',
          url: typeof item.url === 'string' ? item.url : '',
          heatText:
            item.extra && typeof item.extra.info === 'string' && item.extra.info.trim().length > 0
              ? item.extra.info.trim()
              : null,
          rank: index + 1,
        })),
      })),
    });
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
        return this.normalizeAnalysisResponse({ ...fresh, cached: true });
      }

      if (input.allowStale) {
        const stale = await this.safeGet<NewsnowHottestAnalysisResponse>(input.staleKey);
        if (stale) {
          return this.normalizeAnalysisResponse({ ...stale, cached: true });
        }
      }

      await this.delay(ANALYSIS_WAIT_POLL_MS);
    }

    return null;
  }

  private async waitForReadyGlobalSnapshot(input: {
    freshKey: string;
    staleKey: string;
    signature: string;
  }): Promise<NewsnowHottestGlobalSnapshot | null> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < GLOBAL_SNAPSHOT_WAIT_TIMEOUT_MS) {
      const fresh = await this.safeGet<NewsnowHottestGlobalSnapshot>(input.freshKey);
      if (fresh?.signature === input.signature) {
        return fresh;
      }

      const stale = await this.safeGet<NewsnowHottestGlobalSnapshot>(input.staleKey);
      if (stale?.signature === input.signature) {
        return stale;
      }

      await this.delay(GLOBAL_SNAPSHOT_WAIT_POLL_MS);
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
