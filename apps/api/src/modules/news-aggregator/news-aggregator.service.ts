import { ProcessedItemModel, RawItemModel, buildComparableUrlVariants, type ComparableUrlVariants } from "@modular/mongo"
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { createHash } from "node:crypto"

import { CacheService } from "../cache/cache.service"
import { RateLimiterService } from "../cache/rate-limiter.service"
import { PrismaService } from "../config/prisma.service"
import { NewsSourceRuntimeSecretsService } from "../system-settings/news-source-runtime-secrets.service"
import { NewsnowPersonalizationSettingsService } from "../system-settings/newsnow-personalization-settings.service"
import { UserNewsBehaviorService } from "../user-news-behavior/user-news-behavior.service"
import {
  createDefaultNewsnowUiSettings,
  normalizeNewsnowUiSettings,
  UserSettingsService,
} from "../user-settings/user-settings.service"

import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import {
  BATCH_CONCURRENCY,
  BATCH_LIMIT,
  CACHE_PREFIX,
  MAX_ITEMS,
  REFRESH_LOCK_TTL_MS,
  STALE_TTL,
  Time,
} from "./news-aggregator.constants"
import {
  NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
  NewsSourceRuntimeSecretRequiredError,
} from "./news-aggregator.errors"
import type { NewsItem, NewsResolveResponse, SourceID, SourceResponse } from "./news-aggregator.types"
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service"
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher"

const LOCK_WAIT_INTERVAL_MS = 200
const LOCK_MAX_WAIT_MS = REFRESH_LOCK_TTL_MS
const FREEBUF_EMPTY_CACHE_RETRY_MS = 2 * 60 * 1000
const NEWSNOW_SMART_SCORE_MAX_AGE_DAYS = 14
const NEWSNOW_MAX_SOURCE_IDS = 240
const NEWSNOW_PERSONALIZATION_CACHE_KEY_PREFIX = `${CACHE_PREFIX}:personalization:order:v1`
const NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY = `${NEWSNOW_PERSONALIZATION_CACHE_KEY_PREFIX}:index`
const NEWSNOW_PERSONALIZATION_RATE_LIMIT_PREFIX = `${CACHE_PREFIX}:personalization:throttle`
const NEWSNOW_PERSONALIZATION_CACHE_INDEX_TTL_SECONDS = 60 * 30
const NEWSNOW_PERSONALIZATION_MAX_CACHE_TRIM_BATCH = 200
const NEWSNOW_RESOLVE_URL_CACHE_KEY_PREFIX = `${CACHE_PREFIX}:resolve:v1`
const NEWSNOW_RESOLVE_URL_MATCH_TTL_SECONDS = 60 * 5
const NEWSNOW_RESOLVE_URL_MISS_TTL_SECONDS = 30

export interface NewsnowPersonalizationOrderPayload {
  columnKey: string
  sortMode: "manual" | "personalized"
  sourceIds: string[]
  sourceScores: Record<string, number>
  sourceScoreDetails: Record<
    string,
    {
      combinedScore: number
      affinityScore: number
      behaviorScore: number
      affinityWeight: number
      behaviorWeight: number
      affinityContribution: number
      behaviorContribution: number
      negativeContribution: number
      focusBonus: number
    }
  >
  scoreWeights: {
    affinity: number
    behavior: number
    focusBonus: number
  }
  computedAt: string
}

@Injectable()
export class NewsAggregatorService {
  private readonly logger = new Logger(NewsAggregatorService.name)
  private readonly inflightResolveByUrl = new Map<string, Promise<NewsResolveResponse>>()

  constructor(
    private readonly cacheService: CacheService,
    private readonly rateLimiterService: RateLimiterService,
    private readonly prisma: PrismaService,
    private readonly registryService: NewsAggregatorRegistryService,
    private readonly runtimeSecretsService: NewsSourceRuntimeSecretsService,
    private readonly activeSources: NewsnowActiveSourceRegistryService,
    private readonly newsnowRealtime: NewsnowRealtimeDispatcher,
    private readonly userSettingsService: UserSettingsService,
    private readonly personalizationSettingsService: NewsnowPersonalizationSettingsService,
    private readonly userNewsBehavior: UserNewsBehaviorService,
  ) {}

  async fetchSource(id: string, forceRefresh = false): Promise<SourceResponse> {
    const sourceId = id as SourceID
    const source = this.registryService.getSource(sourceId)
    if (!source) {
      throw new NotFoundException(`Unknown source: ${id}`)
    }

    const resolvedId = this.resolveSourceId(sourceId)
    const getter = this.registryService.getGetter(resolvedId)

    if (!getter) {
      throw new NotFoundException(`Source getter not found: ${resolvedId}`)
    }

    const cacheKey = this.buildCacheKey(sourceId)
    const staleKey = this.buildStaleKey(sourceId)
    const skipEmptyCache = sourceId === "freebuf"

    const cached = !forceRefresh ? await this.safeGetCache<SourceResponse>(cacheKey) : null
    if (cached && !forceRefresh) {
      if (skipEmptyCache && this.shouldRetryAfterEmptyCache(cached)) {
        this.logger.warn(`empty cache ignored for "${sourceId}", forcing refresh`)
      } else {
        return { ...cached, id: sourceId, status: "cache" }
      }
    }

    const refresh = async (): Promise<SourceResponse> => {
      const previous = await this.safeGetCache<SourceResponse>(cacheKey)
      const runtimeSecrets = await this.runtimeSecretsService.getSecretsForSource(sourceId, resolvedId)
      const items = this.normalizeItems(await getter({
        sourceId: resolvedId,
        requestedSourceId: sourceId,
        secrets: runtimeSecrets,
      }))
      const response: SourceResponse = {
        status: "success",
        id: sourceId,
        updatedTime: Date.now(),
        items,
      }

      const ttlSeconds = Math.max(1, Math.floor((source.interval ?? Time.Default) / 1000))

      await Promise.all([
        this.cacheService.set(cacheKey, response, ttlSeconds),
        this.cacheService.set(staleKey, response, STALE_TTL),
      ])

      await this.publishRealtimeUpdate({
        sourceId,
        intervalMs: source.interval ?? Time.Default,
        previous,
        current: response,
      })

      return response
    }

    try {
      const lockKey = `${cacheKey}:refresh`
      const lockedResult = await this.cacheService.withLock(lockKey, REFRESH_LOCK_TTL_MS, refresh)
      if (lockedResult) {
        return lockedResult
      }

      // Lock not acquired — another process is refreshing. Poll for cache.
      const polled = await this.pollForCache<SourceResponse>(cacheKey, LOCK_WAIT_INTERVAL_MS, LOCK_MAX_WAIT_MS)
      if (polled) {
        if (skipEmptyCache && this.shouldRetryAfterEmptyCache(polled)) {
          this.logger.warn(`empty polled cache ignored for "${sourceId}", retrying refresh path`)
        } else {
          return { ...polled, id: sourceId, status: "cache" }
        }
      }

      // Poll timed out — try stale fallback instead of redundant refresh
      const stale = await this.safeGetCache<SourceResponse>(staleKey)
      if (stale) {
        if (skipEmptyCache && this.shouldRetryAfterEmptyCache(stale)) {
          this.logger.warn(`empty stale cache ignored for "${sourceId}", forcing refresh`)
        } else {
          this.logger.warn(`lock contention for "${sourceId}", serving stale data`)
          return { ...stale, id: sourceId, status: "cache" }
        }
      }

      // No stale data available — last resort, do the refresh
      return await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      this.logger.error(`source refresh failed for "${sourceId}": ${message}`, stack)
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error
      }
      throw this.buildSourceFetchException(sourceId, error)
    }
  }

  private buildSourceFetchException(sourceId: string, error: unknown): HttpException {
    if (error instanceof NewsSourceRuntimeSecretRequiredError) {
      return new HttpException(
        {
          code: NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
          message: `Runtime secret required for news source: ${sourceId}`,
          detail:
            error.requiredKeys.length > 0
              ? `Configure at least one runtime secret: ${error.requiredKeys.join(", ")}`
              : "Configure the required runtime secret in system settings.",
          sourceId,
          requiredKeys: error.requiredKeys,
        },
        HttpStatus.FAILED_DEPENDENCY,
      )
    }

    const detailRaw = error instanceof Error ? error.message : String(error)
    const detail = detailRaw.length > 240 ? `${detailRaw.slice(0, 237)}...` : detailRaw
    return new HttpException(
      {
        code: "NEWS_SOURCE_FETCH_FAILED",
        message: `Failed to fetch news source: ${sourceId}`,
        detail,
      },
      HttpStatus.BAD_GATEWAY,
    )
  }

  private shouldRetryAfterEmptyCache(response: SourceResponse): boolean {
    if (response.items.length > 0) {
      return false
    }

    const updatedTime = typeof response.updatedTime === "number"
      ? response.updatedTime
      : Number(response.updatedTime)

    if (!Number.isFinite(updatedTime)) {
      return true
    }

    return Date.now() - updatedTime >= FREEBUF_EMPTY_CACHE_RETRY_MS
  }

  async fetchBatch(ids: string[], forceRefresh = false) {
    if (!Array.isArray(ids)) {
      throw new BadRequestException("sources must be an array")
    }

    const uniqueIds = [...new Set(ids.filter(Boolean))]
    const batchIds = uniqueIds.slice(0, BATCH_LIMIT)
    const settledResults: PromiseSettledResult<SourceResponse>[] = []

    for (let index = 0; index < batchIds.length; index += BATCH_CONCURRENCY) {
      const chunk = batchIds.slice(index, index + BATCH_CONCURRENCY)
      const chunkResult = await Promise.allSettled(
        chunk.map((sourceId) => this.fetchSource(sourceId, forceRefresh)),
      )
      settledResults.push(...chunkResult)
    }

    const results: SourceResponse[] = []
    const errors: { id: string, message: string }[] = []

    settledResults.forEach((result, index) => {
      const sourceId = batchIds[index]!
      if (result.status === "fulfilled") {
        results.push(result.value)
      } else {
        errors.push({
          id: sourceId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })

    return {
      requested: ids.length,
      processed: batchIds.length,
      results,
      errors,
    }
  }

  getMetadata() {
    return this.registryService.getMetadata()
  }

  async getPersonalizedSourceOrderForUser(input: {
    orgId: string
    userId: string
    columnKey: string
    sourceIds: string[]
    settingsOverride?: Record<string, unknown>
  }) {
    const runtimePolicy =
      await this.personalizationSettingsService.getRuntimeSettings()
    this.personalizationSettingsService.recordRuntimeMetricsBestEffort({
      requestCount: 1,
    })

    const metadata = this.registryService.getMetadata()
    const availableSourceIds = new Set<string>(Object.keys(metadata.sources))
    const columnsRecord = metadata.columns as Record<
      string,
      { sources?: (string | SourceID)[] } | undefined
    >
    const fallbackSourceIds = this.normalizePersonalizationSourceIds(
      columnsRecord[input.columnKey]?.sources ?? [],
      availableSourceIds,
    )
    const requestedSourceIds = this.normalizePersonalizationSourceIds(
      input.sourceIds,
      availableSourceIds,
    )
    const baseSourceIds =
      requestedSourceIds.length > 0 ? requestedSourceIds : fallbackSourceIds

    const overrideSettings = input.settingsOverride
      ? normalizeNewsnowUiSettings(input.settingsOverride)
      : null
    const persistedSettingsResponse = overrideSettings
      ? null
      : await this.userSettingsService.getNewsnowUiSettings(
          input.orgId,
          input.userId,
        )
    const settings =
      overrideSettings ??
      persistedSettingsResponse?.settings ??
      createDefaultNewsnowUiSettings()
    const settingsSignature = overrideSettings
      ? this.stableSerializeForCache(overrideSettings)
      : (persistedSettingsResponse?.updatedAt?.settings ?? "default")
    const runtimePolicySignature = this.stableSerializeForCache({
      cacheTtlMs: runtimePolicy.cacheTtlMs,
      maxCacheEntries: runtimePolicy.maxCacheEntries,
      throttleWindowMs: runtimePolicy.throttleWindowMs,
      maxRequestsPerWindowPerUser: runtimePolicy.maxRequestsPerWindowPerUser,
      affinitySourceWeight: runtimePolicy.affinitySourceWeight,
      behaviorSourceWeight: runtimePolicy.behaviorSourceWeight,
      focusSourceBonus: runtimePolicy.focusSourceBonus,
      staleTtlStrategy: runtimePolicy.staleTtlStrategy,
      staleTtlMultiplier: runtimePolicy.staleTtlMultiplier,
      staleTtlFixedMs: runtimePolicy.staleTtlFixedMs,
    })

    const cacheKey = this.buildPersonalizationCacheKey({
      orgId: input.orgId,
      userId: input.userId,
      columnKey: input.columnKey,
      sourceIds: baseSourceIds,
      settingsSignature,
      runtimePolicySignature,
    })
    const cacheToken = this.hashPersonalizationCacheKey(cacheKey)
    const freshCacheKey = this.buildPersonalizationRedisFreshCacheKey(cacheToken)
    const staleCacheKey = this.buildPersonalizationRedisStaleCacheKey(cacheToken)

    const freshCachedResponse =
      runtimePolicy.cacheTtlMs > 0
        ? await this.getPersonalizationCachePayload(freshCacheKey)
        : null
    if (freshCachedResponse) {
      this.personalizationSettingsService.recordRuntimeMetricsBestEffort({
        cacheHitFreshCount: 1,
      })
      return freshCachedResponse
    }

    const throttleAllowed = await this.consumePersonalizationThrottle({
      key: `${input.orgId}:${input.userId}`,
      windowMs: runtimePolicy.throttleWindowMs,
      limit: runtimePolicy.maxRequestsPerWindowPerUser,
    })
    if (!throttleAllowed) {
      const staleCachedResponse = await this.getPersonalizationCachePayload(
        staleCacheKey,
      )
      if (staleCachedResponse) {
        this.personalizationSettingsService.recordRuntimeMetricsBestEffort({
          throttleLimitedCount: 1,
          cacheHitStaleCount: 1,
        })
        return staleCachedResponse
      }
      this.personalizationSettingsService.recordRuntimeMetricsBestEffort({
        throttleLimitedCount: 1,
        throttleRejectedCount: 1,
      })
      throw new HttpException(
        "NewsNow personalized ordering is rate limited. Please retry shortly.",
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const manualOrder = settings.columnOrders[input.columnKey] ?? []
    const manuallyOrdered = this.applyManualOrder(baseSourceIds, manualOrder)
    const normalizedWeights = this.normalizeRankingSourceWeights({
      affinitySourceWeight: runtimePolicy.affinitySourceWeight,
      behaviorSourceWeight: runtimePolicy.behaviorSourceWeight,
    })
    const scoreWeights = {
      affinity: Number(normalizedWeights.affinity.toFixed(4)),
      behavior: Number(normalizedWeights.behavior.toFixed(4)),
      focusBonus: Number(runtimePolicy.focusSourceBonus.toFixed(4)),
    }

    const personalizedEnabled =
      settings.sortMode === "smart" || settings.sortMode === "personalized"

    if (!personalizedEnabled) {
      const payload = {
        columnKey: input.columnKey,
        sortMode: "manual" as const,
        sourceIds: manuallyOrdered,
        sourceScores: {},
        sourceScoreDetails: {},
        scoreWeights,
        computedAt: new Date().toISOString(),
      }
      await this.cachePersonalizationResponseIfEnabled({
        cacheToken,
        payload,
        cacheTtlMs: runtimePolicy.cacheTtlMs,
        throttleWindowMs: runtimePolicy.throttleWindowMs,
        staleTtlStrategy: runtimePolicy.staleTtlStrategy,
        staleTtlMultiplier: runtimePolicy.staleTtlMultiplier,
        staleTtlFixedMs: runtimePolicy.staleTtlFixedMs,
        maxCacheEntries: runtimePolicy.maxCacheEntries,
      })
      return payload
    }

    const focusSet = new Set(settings.focusSources)
    const sourceMetaRecord = metadata.sources as Record<
      string,
      { name?: string; title?: string; home?: string } | undefined
    >
    const behaviorProfile = await this.userNewsBehavior.getPersonalizationProfile(
      input.orgId,
      input.userId,
    )
    const positiveBehaviorSourceScores = behaviorProfile.positive.sources
    const negativeBehaviorSourceScores = behaviorProfile.negative.sources
    const maxPositiveBehaviorSourceScore = Math.max(
      0,
      ...Object.values(positiveBehaviorSourceScores),
    )
    const maxNegativeBehaviorSourceScore = Math.max(
      0,
      ...Object.values(negativeBehaviorSourceScores),
    )
    const positiveBehaviorScoreNormalizer = maxPositiveBehaviorSourceScore > 0
      ? Math.log1p(maxPositiveBehaviorSourceScore)
      : 0
    const negativeBehaviorScoreNormalizer = maxNegativeBehaviorSourceScore > 0
      ? Math.log1p(maxNegativeBehaviorSourceScore)
      : 0
    const scoringNow = Date.now()
    const scored = manuallyOrdered.map((sourceId, index) => {
      const affinity = settings.sourceAffinity[sourceId]
      const baseScore =
        affinity && typeof affinity.score === "number" && Number.isFinite(affinity.score)
          ? this.clamp(affinity.score, 0, 100)
          : 0
      const elapsedDays =
        affinity && typeof affinity.lastInteractedAt === "number"
          ? this.clamp(
              (scoringNow - affinity.lastInteractedAt) / (24 * 60 * 60 * 1000),
              0,
              NEWSNOW_SMART_SCORE_MAX_AGE_DAYS,
            )
          : NEWSNOW_SMART_SCORE_MAX_AGE_DAYS
      const recencyFactor = 1 - elapsedDays / (NEWSNOW_SMART_SCORE_MAX_AGE_DAYS * 1.25)
      const recencyWeighted = baseScore * this.clamp(recencyFactor, 0.2, 1)
      const focusBonus = focusSet.has(sourceId) ? runtimePolicy.focusSourceBonus : 0
      const positiveBehaviorRaw = this.resolveBehaviorSourceScore({
        sourceId,
        sourceMeta: sourceMetaRecord[sourceId],
        behaviorSourceScores: positiveBehaviorSourceScores,
      })
      const negativeBehaviorRaw = this.resolveBehaviorSourceScore({
        sourceId,
        sourceMeta: sourceMetaRecord[sourceId],
        behaviorSourceScores: negativeBehaviorSourceScores,
      })
      const positiveBehaviorNormalized =
        positiveBehaviorRaw > 0 && positiveBehaviorScoreNormalizer > 0
          ? this.clamp(
              Math.log1p(positiveBehaviorRaw) / positiveBehaviorScoreNormalizer,
              0,
              1,
            )
          : 0
      const negativeBehaviorNormalized =
        negativeBehaviorRaw > 0 && negativeBehaviorScoreNormalizer > 0
          ? this.clamp(
              Math.log1p(negativeBehaviorRaw) / negativeBehaviorScoreNormalizer,
              0,
              1,
            )
          : 0
      const behaviorWeighted = (positiveBehaviorNormalized - negativeBehaviorNormalized * 1.15) * 100
      const affinityContribution = recencyWeighted * normalizedWeights.affinity
      const behaviorContribution = behaviorWeighted * normalizedWeights.behavior
      const negativeContribution = Number(
        (negativeBehaviorNormalized * 100 * normalizedWeights.behavior).toFixed(4),
      )
      const combinedScore =
        affinityContribution +
        behaviorContribution +
        focusBonus
      const displayCombinedScore = this.clamp(combinedScore, 0, 100)
      return {
        sourceId,
        index,
        score: combinedScore,
        displayScore: displayCombinedScore,
        detail: {
          combinedScore: Number(combinedScore.toFixed(4)),
          affinityScore: Number(recencyWeighted.toFixed(4)),
          behaviorScore: Number(behaviorWeighted.toFixed(4)),
          affinityWeight: scoreWeights.affinity,
          behaviorWeight: scoreWeights.behavior,
          affinityContribution: Number(affinityContribution.toFixed(4)),
          behaviorContribution: Number(behaviorContribution.toFixed(4)),
          negativeContribution,
          focusBonus: Number(focusBonus.toFixed(4)),
        },
      }
    })

    const sorted = [...scored].sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.0001) {
        return b.score - a.score
      }
      return a.index - b.index
    })

    const sourceScores: Record<string, number> = {}
    const sourceScoreDetails: Record<string, NewsnowPersonalizationOrderPayload["sourceScoreDetails"][string]> = {}
    sorted.forEach((entry) => {
      sourceScores[entry.sourceId] = Number(entry.displayScore.toFixed(4))
      sourceScoreDetails[entry.sourceId] = entry.detail
    })

    const payload = {
      columnKey: input.columnKey,
      sortMode: "personalized" as const,
      sourceIds: sorted.map((entry) => entry.sourceId),
      sourceScores,
      sourceScoreDetails,
      scoreWeights,
      computedAt: new Date().toISOString(),
    }
    await this.cachePersonalizationResponseIfEnabled({
      cacheToken,
      payload,
      cacheTtlMs: runtimePolicy.cacheTtlMs,
      throttleWindowMs: runtimePolicy.throttleWindowMs,
      staleTtlStrategy: runtimePolicy.staleTtlStrategy,
      staleTtlMultiplier: runtimePolicy.staleTtlMultiplier,
      staleTtlFixedMs: runtimePolicy.staleTtlFixedMs,
      maxCacheEntries: runtimePolicy.maxCacheEntries,
    })
    return payload
  }

  async resolveByUrl(url: string): Promise<NewsResolveResponse> {
    const rawUrl = url.trim()
    const comparable = buildComparableUrlVariants(rawUrl)
    if (!comparable) {
      return { matched: false }
    }

    const cacheKey = this.buildResolveByUrlCacheKey(comparable)
    const cached = await this.safeGetCache<NewsResolveResponse>(cacheKey)
    if (cached) {
      return cached
    }

    const inflight = this.inflightResolveByUrl.get(cacheKey)
    if (inflight) {
      return await inflight
    }

    const resolvePromise = this.resolveByUrlUncached(rawUrl, comparable)
      .then(async (resolved) => {
        await this.safeSetResolveByUrlCache(cacheKey, resolved)
        return resolved
      })

    this.inflightResolveByUrl.set(cacheKey, resolvePromise)

    try {
      return await resolvePromise
    } finally {
      if (this.inflightResolveByUrl.get(cacheKey) === resolvePromise) {
        this.inflightResolveByUrl.delete(cacheKey)
      }
    }
  }

  private async resolveByUrlUncached(rawUrl: string, input: ComparableUrlVariants): Promise<NewsResolveResponse> {
    const projection = { itemMetaId: 1, "payload.url": 1, createdAt: 1 }
    const exactComparableHashMatch = await RawItemModel.findOne(
      {
        urlComparableFullHash: input.fullHash,
        urlComparableFull: input.full,
      },
      projection,
    )
      .sort({ createdAt: -1 })
      .lean()

    const exactComparableLegacyMatch = exactComparableHashMatch
      ? null
      : await RawItemModel.findOne(
          { urlComparableFull: input.full },
          projection,
        )
          .sort({ createdAt: -1 })
          .lean()

    const exactPayloadUrlCandidates = [...new Set([rawUrl, input.full].filter((value) => value.length > 0))]
    const exactPayloadUrlFilter =
      exactPayloadUrlCandidates.length === 0
        ? null
        : exactPayloadUrlCandidates.length === 1
          ? exactPayloadUrlCandidates[0]
          : { $in: exactPayloadUrlCandidates }

    // Keep the legacy payload.url exact-match path ahead of base matching until older rows are backfilled.
    const exactPayloadMatch = exactComparableHashMatch || exactComparableLegacyMatch || !exactPayloadUrlFilter
      ? null
      : await RawItemModel.findOne(
          { "payload.url": exactPayloadUrlFilter },
          projection,
        )
          .sort({ createdAt: -1 })
          .lean()

    const baseMatch = exactComparableHashMatch || exactComparableLegacyMatch || exactPayloadMatch
      ? null
      : await RawItemModel.findOne(
          { urlComparableBase: input.base },
          projection,
        )
          .sort({ createdAt: -1 })
          .lean()

    const fallbackPattern = `^${this.escapeRegex(input.base)}(?:/)?(?:[?#].*)?$`
    const fallbackMatch = exactComparableHashMatch || exactComparableLegacyMatch || exactPayloadMatch || baseMatch
      ? null
      : await RawItemModel.findOne(
          { "payload.url": { $regex: fallbackPattern, $options: "i" } },
          projection,
        )
          .sort({ createdAt: -1 })
          .lean()

    const resolvedRaw =
      exactComparableHashMatch
      ?? exactComparableLegacyMatch
      ?? exactPayloadMatch
      ?? baseMatch
      ?? fallbackMatch
    const itemMetaId =
      resolvedRaw && typeof resolvedRaw.itemMetaId === "string"
        ? resolvedRaw.itemMetaId.trim()
        : ""
    if (!itemMetaId) {
      return { matched: false }
    }

    const processedRows = await ProcessedItemModel.find(
      {
        itemMetaId,
        status: "completed",
      },
      { _id: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()

    const processedItemIds = processedRows
      .map((row) => row._id?.toString?.())
      .filter((value): value is string => typeof value === "string" && value.length > 0)

    const linkedEvent = processedItemIds.length
      ? await this.prisma.newsEventItem.findFirst({
          where: {
            processedItemId: { in: processedItemIds },
          },
          orderBy: { createdAt: "desc" },
          select: { eventId: true },
        })
      : null

    const matchedUrl =
      resolvedRaw &&
      typeof (resolvedRaw as { payload?: { url?: unknown } }).payload?.url === "string"
        ? ((resolvedRaw as { payload: { url: string } }).payload.url)
        : undefined
    const confidence =
      exactComparableHashMatch || exactComparableLegacyMatch || exactPayloadMatch
        ? 1
        : baseMatch
          ? 0.93
          : 0.86

    return {
      matched: true,
      itemId: itemMetaId,
      ...(linkedEvent?.eventId ? { eventId: linkedEvent.eventId } : {}),
      confidence,
      ...(matchedUrl ? { matchedUrl } : {}),
    }
  }

  private resolveSourceId(sourceId: SourceID): SourceID {
    const visited = new Set<SourceID>()
    let current = sourceId

    for (;;) {
      if (visited.has(current)) {
        this.logger.warn(`redirect cycle detected for "${sourceId}": ${[...visited].join(" -> ")} -> ${current}`)
        return sourceId
      }
      visited.add(current)

      const currentSource = this.registryService.getSource(current)
      if (!currentSource?.redirect) {
        return current
      }

      current = currentSource.redirect
    }
  }

  private static readonly SAFE_URL_PATTERN = /^https?:\/\//i

  private normalizeItems(items: NewsItem[]): NewsItem[] {
    const normalized = items.filter((item) => {
      return Boolean(item)
        && item.id !== undefined
        && item.id !== null
        && typeof item.title === "string"
        && item.title.length > 0
        && typeof item.url === "string"
        && item.url.length > 0
        && NewsAggregatorService.SAFE_URL_PATTERN.test(item.url)
    })

    return normalized.slice(0, MAX_ITEMS)
  }

  private async safeGetCache<T>(key: string): Promise<T | null> {
    try {
      return await this.cacheService.get<T>(key)
    } catch (error) {
      this.logger.warn(`cache read failed for "${key}": ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private async pollForCache<T>(key: string, intervalMs: number, maxWaitMs: number): Promise<T | null> {
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      const cached = await this.safeGetCache<T>(key)
      if (cached) return cached
    }
    return null
  }

  private buildCacheKey(sourceId: SourceID): string {
    return `${CACHE_PREFIX}:source:${sourceId}`
  }

  private buildStaleKey(sourceId: SourceID): string {
    return `${CACHE_PREFIX}:source:${sourceId}:stale`
  }

  private buildResolveByUrlCacheKey(input: ComparableUrlVariants): string {
    const token = createHash("sha1")
      .update(`${input.full}|${input.base}`)
      .digest("hex")
    return `${NEWSNOW_RESOLVE_URL_CACHE_KEY_PREFIX}:${token}`
  }

  private async safeSetResolveByUrlCache(key: string, value: NewsResolveResponse) {
    try {
      await this.cacheService.set(
        key,
        value,
        value.matched ? NEWSNOW_RESOLVE_URL_MATCH_TTL_SECONDS : NEWSNOW_RESOLVE_URL_MISS_TTL_SECONDS,
      )
    } catch (error) {
      this.logger.warn(`cache write failed for "${key}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  private stableSerializeForCache(value: unknown): string {
    if (value === null || value === undefined) {
      return "null"
    }
    if (typeof value !== "object") {
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableSerializeForCache(entry)).join(",")}]`
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b))
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${this.stableSerializeForCache(record[key])}`)
      .join(",")}}`
  }

  private buildPersonalizationCacheKey(input: {
    orgId: string
    userId: string
    columnKey: string
    sourceIds: string[]
    settingsSignature: string
    runtimePolicySignature: string
  }) {
    return [
      input.orgId,
      input.userId,
      input.columnKey,
      input.sourceIds.join(","),
      input.settingsSignature,
      input.runtimePolicySignature,
    ].join("|")
  }

  private hashPersonalizationCacheKey(cacheKey: string) {
    return createHash("sha1").update(cacheKey).digest("hex")
  }

  private buildPersonalizationRedisFreshCacheKey(cacheToken: string) {
    return `${NEWSNOW_PERSONALIZATION_CACHE_KEY_PREFIX}:fresh:${cacheToken}`
  }

  private buildPersonalizationRedisStaleCacheKey(cacheToken: string) {
    return `${NEWSNOW_PERSONALIZATION_CACHE_KEY_PREFIX}:stale:${cacheToken}`
  }

  private async getPersonalizationCachePayload(key: string) {
    try {
      return await this.cacheService.get<NewsnowPersonalizationOrderPayload>(key)
    } catch (error) {
      this.logger.warn(
        `personalization cache read failed for "${key}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private async consumePersonalizationThrottle(input: {
    key: string
    windowMs: number
    limit: number
  }) {
    const { key, windowMs, limit } = input
    if (limit <= 0 || windowMs <= 0) {
      return true
    }
    const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000))
    const rateKey = `${NEWSNOW_PERSONALIZATION_RATE_LIMIT_PREFIX}:${key}`
    try {
      return await this.rateLimiterService.consume(rateKey, limit, windowSeconds)
    } catch (error) {
      this.logger.warn(
        `personalization throttle failed for "${rateKey}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return true
    }
  }

  private async cachePersonalizationResponseIfEnabled(input: {
    cacheToken: string
    payload: NewsnowPersonalizationOrderPayload
    cacheTtlMs: number
    throttleWindowMs: number
    staleTtlStrategy: "multiplier" | "fixed"
    staleTtlMultiplier: number
    staleTtlFixedMs: number
    maxCacheEntries: number
  }) {
    const {
      cacheToken,
      payload,
      cacheTtlMs,
      throttleWindowMs,
      staleTtlStrategy,
      staleTtlMultiplier,
      staleTtlFixedMs,
      maxCacheEntries,
    } = input
    if (cacheTtlMs <= 0) {
      return
    }
    const freshKey = this.buildPersonalizationRedisFreshCacheKey(cacheToken)
    const staleKey = this.buildPersonalizationRedisStaleCacheKey(cacheToken)
    const now = Date.now()
    const freshTtlSeconds = this.msToTtlSeconds(cacheTtlMs)
    const staleTtlMs = this.personalizationSettingsService.resolveStaleTtlMs({
      cacheTtlMs,
      throttleWindowMs,
      staleTtlStrategy,
      staleTtlMultiplier,
      staleTtlFixedMs,
    })
    const staleTtlSeconds = this.msToTtlSeconds(staleTtlMs)

    try {
      await Promise.all([
        this.cacheService.set(freshKey, payload, freshTtlSeconds),
        this.cacheService.set(staleKey, payload, staleTtlSeconds),
        this.cacheService.zadd(NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY, now, cacheToken),
        this.cacheService.expire(
          NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY,
          NEWSNOW_PERSONALIZATION_CACHE_INDEX_TTL_SECONDS,
        ),
      ])
    } catch (error) {
      this.logger.warn(
        `personalization cache write failed for token "${cacheToken}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    await this.trimPersonalizationCache(maxCacheEntries)
  }

  private async trimPersonalizationCache(maxCacheEntries: number) {
    const maxEntries = Math.max(1, maxCacheEntries)
    let size = 0
    try {
      size = await this.cacheService.zcard(NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY)
    } catch (error) {
      this.logger.warn(
        `personalization cache index size read failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (size <= maxEntries) {
      return
    }

    const overflow = size - maxEntries
    const trimCount = Math.min(
      Math.max(1, overflow),
      NEWSNOW_PERSONALIZATION_MAX_CACHE_TRIM_BATCH,
    )

    let evictTokens: string[] = []
    try {
      evictTokens = await this.cacheService.zrange(
        NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY,
        0,
        trimCount - 1,
      )
    } catch (error) {
      this.logger.warn(
        `personalization cache index scan failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!evictTokens.length) {
      return
    }

    try {
      await this.cacheService.zrem(NEWSNOW_PERSONALIZATION_CACHE_INDEX_KEY, evictTokens)
      const keys = evictTokens.flatMap((cacheToken) => [
        this.buildPersonalizationRedisFreshCacheKey(cacheToken),
        this.buildPersonalizationRedisStaleCacheKey(cacheToken),
      ])
      await this.cacheService.delMany(keys)
      this.personalizationSettingsService.recordRuntimeMetricsBestEffort({
        trimCount: 1,
        trimEvictedCount: evictTokens.length,
      })
    } catch (error) {
      this.logger.warn(
        `personalization cache trim failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private msToTtlSeconds(ms: number) {
    return Math.max(1, Math.ceil(ms / 1000))
  }

  private normalizePersonalizationSourceIds(
    sourceIds: (string | SourceID)[],
    availableSourceIds: Set<string>,
  ): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const rawSourceId of sourceIds) {
      const sourceId =
        typeof rawSourceId === "string" ? rawSourceId.trim() : String(rawSourceId).trim()
      if (!sourceId || seen.has(sourceId) || !availableSourceIds.has(sourceId)) {
        continue
      }
      seen.add(sourceId)
      out.push(sourceId)
      if (out.length >= NEWSNOW_MAX_SOURCE_IDS) {
        break
      }
    }
    return out
  }

  private applyManualOrder(sourceIds: string[], manualOrder: string[]): string[] {
    if (!Array.isArray(manualOrder) || manualOrder.length === 0) {
      return sourceIds
    }
    const sourceSet = new Set(sourceIds)
    const ordered: string[] = []
    const seen = new Set<string>()
    for (const sourceId of manualOrder) {
      if (!sourceSet.has(sourceId) || seen.has(sourceId)) {
        continue
      }
      seen.add(sourceId)
      ordered.push(sourceId)
    }
    for (const sourceId of sourceIds) {
      if (seen.has(sourceId)) {
        continue
      }
      ordered.push(sourceId)
    }
    return ordered
  }

  private resolveBehaviorSourceScore(input: {
    sourceId: string
    sourceMeta?: { name?: string; title?: string; home?: string } | null
    behaviorSourceScores: Record<string, number>
  }) {
    let score = 0
    const candidates = this.buildSourceBehaviorAliases(
      input.sourceId,
      input.sourceMeta,
    )
    for (const candidate of candidates) {
      const value = input.behaviorSourceScores[candidate]
      if (typeof value === "number" && Number.isFinite(value) && value > score) {
        score = value
      }
    }
    return score
  }

  private buildSourceBehaviorAliases(
    sourceId: string,
    sourceMeta?: { name?: string; title?: string; home?: string } | null,
  ) {
    const aliases: string[] = []
    const seen = new Set<string>()
    const push = (value?: string | null) => {
      const normalized = this.normalizeBehaviorTerm(value)
      if (!normalized || seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      aliases.push(normalized)
    }

    push(sourceId)
    const baseSourceId = sourceId.split("-")[0] ?? sourceId
    if (baseSourceId !== sourceId) {
      push(baseSourceId)
    }
    push(sourceMeta?.name)
    push(sourceMeta?.title)
    push(this.extractDomainFromUrl(sourceMeta?.home))
    return aliases
  }

  private normalizeBehaviorTerm(value?: string | null) {
    if (typeof value !== "string") {
      return null
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 96)
    return normalized.length > 0 ? normalized : null
  }

  private extractDomainFromUrl(value?: string | null) {
    if (typeof value !== "string") {
      return null
    }
    const raw = value.trim()
    if (!raw) {
      return null
    }
    const parse = (candidate: string) => {
      try {
        const parsed = new URL(candidate)
        const hostname = parsed.hostname.trim().toLowerCase().replace(/^www\./, "")
        return this.normalizeBehaviorTerm(hostname)
      } catch {
        return null
      }
    }
    return parse(raw) ?? parse(`https://${raw}`)
  }

  private normalizeRankingSourceWeights(input: {
    affinitySourceWeight: number
    behaviorSourceWeight: number
  }) {
    const affinity = Number.isFinite(input.affinitySourceWeight)
      ? this.clamp(input.affinitySourceWeight, 0, Number.MAX_SAFE_INTEGER)
      : 0
    const behavior = Number.isFinite(input.behaviorSourceWeight)
      ? this.clamp(input.behaviorSourceWeight, 0, Number.MAX_SAFE_INTEGER)
      : 0
    const sum = affinity + behavior
    if (sum <= 0) {
      return {
        affinity: 0.5,
        behavior: 0.5,
      }
    }
    return {
      affinity: affinity / sum,
      behavior: behavior / sum,
    }
  }

  private clamp(value: number, min: number, max: number): number {
    if (value < min) {
      return min
    }
    if (value > max) {
      return max
    }
    return value
  }

  private async publishRealtimeUpdate(input: {
    orgId?: string
    sourceId: SourceID
    intervalMs: number
    previous: SourceResponse | null
    current: SourceResponse
  }) {
    const { orgId, sourceId, intervalMs, previous, current } = input
    if (!previous || !Array.isArray(previous.items) || previous.items.length === 0) {
      return
    }

    const previousIds = new Set(previous.items.map((item) => String(item.id)))
    let newItemsCount = 0
    const topTitles: string[] = []

    for (const item of current.items) {
      const id = String(item.id)
      if (previousIds.has(id)) {
        continue
      }
      newItemsCount += 1
      if (topTitles.length < 3 && typeof item.title === "string" && item.title.trim().length > 0) {
        topTitles.push(item.title.trim().slice(0, 200))
      }
    }

    if (newItemsCount <= 0) {
      return
    }

    const updatedTime =
      typeof current.updatedTime === "number"
        ? new Date(current.updatedTime).toISOString()
        : typeof current.updatedTime === "string" && current.updatedTime.trim().length > 0
          ? current.updatedTime
          : new Date().toISOString()

    try {
      const targetOrgIds = this.resolveRealtimeTargetOrgIds(orgId, sourceId)
      if (targetOrgIds.length === 0) {
        return
      }

      await Promise.all(
        targetOrgIds.map((targetOrgId) =>
          this.newsnowRealtime.publish({
            orgId: targetOrgId,
            sourceId,
            newItemsCount,
            topTitles,
            updatedTime,
            intervalMs: Math.max(1_000, intervalMs),
          }),
        ),
      )
    } catch (error) {
      this.logger.warn(
        {
          sourceId,
          newItemsCount,
          error: error instanceof Error ? error.message : String(error),
        },
        "failed to publish newsnow realtime event",
      )
    }
  }

  private resolveRealtimeTargetOrgIds(orgId: string | undefined, sourceId: SourceID) {
    const explicitOrgId = typeof orgId === "string" ? orgId.trim() : ""
    if (explicitOrgId) {
      return [explicitOrgId]
    }

    return this.activeSources.getOrgIdsForSource(sourceId)
  }
}
