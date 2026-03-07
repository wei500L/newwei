import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ProcessedItemModel, RawItemModel } from "@modular/mongo"
import { createHash } from "node:crypto"

import { CacheService } from "../cache/cache.service"
import { RateLimiterService } from "../cache/rate-limiter.service"
import { PrismaService } from "../config/prisma.service"
import { NewsnowPersonalizationSettingsService } from "../system-settings/newsnow-personalization-settings.service";
import { NewsSourceRuntimeSecretsService } from "../system-settings/news-source-runtime-secrets.service"
import { buildUserNewsBehaviorHashKey } from "../user-news-behavior/user-news-behavior.constants"
import {
  createDefaultNewsnowUiSettings,
  normalizeNewsnowUiSettings,
  UserSettingsService,
} from "../user-settings/user-settings.service";
import {
  NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
  NewsSourceRuntimeSecretRequiredError,
} from "./news-aggregator.errors"
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";
import type { NewsItem, NewsResolveResponse, SourceID, SourceResponse } from "./news-aggregator.types"

import {
  BATCH_CONCURRENCY,
  BATCH_LIMIT,
  CACHE_PREFIX,
  MAX_ITEMS,
  REFRESH_LOCK_TTL_MS,
  STALE_TTL,
  Time,
} from "./news-aggregator.constants"

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

type NewsnowPersonalizationOrderPayload = {
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

  constructor(
    private readonly cacheService: CacheService,
    private readonly rateLimiterService: RateLimiterService,
    private readonly prisma: PrismaService,
    private readonly registryService: NewsAggregatorRegistryService,
    private readonly runtimeSecretsService: NewsSourceRuntimeSecretsService,
    private readonly newsnowRealtime: NewsnowRealtimeDispatcher,
    private readonly userSettingsService: UserSettingsService,
    private readonly personalizationSettingsService: NewsnowPersonalizationSettingsService,
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

  async fetchBatch(ids: string[]) {
    if (!Array.isArray(ids)) {
      throw new BadRequestException("sources must be an array")
    }

    const uniqueIds = [...new Set(ids.filter(Boolean))]
    const batchIds = uniqueIds.slice(0, BATCH_LIMIT)
    const settledResults: Array<PromiseSettledResult<SourceResponse>> = []

    for (let index = 0; index < batchIds.length; index += BATCH_CONCURRENCY) {
      const chunk = batchIds.slice(index, index + BATCH_CONCURRENCY)
      const chunkResult = await Promise.allSettled(chunk.map((sourceId) => this.fetchSource(sourceId)))
      settledResults.push(...chunkResult)
    }

    const results: SourceResponse[] = []
    const errors: Array<{ id: string, message: string }> = []

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
      { sources?: Array<string | SourceID> } | undefined
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
    const behaviorSourceScores = await this.loadUserBehaviorSourceScores(
      input.orgId,
      input.userId,
    )
    const maxBehaviorSourceScore = Math.max(
      0,
      ...Object.values(behaviorSourceScores),
    )
    const behaviorScoreNormalizer = maxBehaviorSourceScore > 0
      ? Math.log1p(maxBehaviorSourceScore)
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
      const behaviorRaw = this.resolveBehaviorSourceScore({
        sourceId,
        sourceMeta: sourceMetaRecord[sourceId],
        behaviorSourceScores,
      })
      const behaviorNormalized =
        behaviorRaw > 0 && behaviorScoreNormalizer > 0
          ? this.clamp(Math.log1p(behaviorRaw) / behaviorScoreNormalizer, 0, 1)
          : 0
      const behaviorWeighted = behaviorNormalized * 100
      const affinityContribution = recencyWeighted * normalizedWeights.affinity
      const behaviorContribution = behaviorWeighted * normalizedWeights.behavior
      const combinedScore =
        affinityContribution +
        behaviorContribution +
        focusBonus
      return {
        sourceId,
        index,
        score: combinedScore,
        detail: {
          combinedScore: Number(combinedScore.toFixed(4)),
          affinityScore: Number(recencyWeighted.toFixed(4)),
          behaviorScore: Number(behaviorWeighted.toFixed(4)),
          affinityWeight: scoreWeights.affinity,
          behaviorWeight: scoreWeights.behavior,
          affinityContribution: Number(affinityContribution.toFixed(4)),
          behaviorContribution: Number(behaviorContribution.toFixed(4)),
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
      sourceScores[entry.sourceId] = Number(entry.score.toFixed(4))
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
    const normalizedFull = this.normalizeComparableUrl(url, { keepSearch: true })
    const normalizedBase = this.normalizeComparableUrl(url, { keepSearch: false })
    if (!normalizedFull || !normalizedBase) {
      return { matched: false }
    }

    const exactCandidates = Array.from(new Set([normalizedFull, normalizedBase]))
    const exactMatch = await RawItemModel.findOne(
      { "payload.url": { $in: exactCandidates } },
      { itemMetaId: 1, "payload.url": 1, createdAt: 1 },
    )
      .sort({ createdAt: -1 })
      .lean()

    const fallbackPattern = `^${this.escapeRegex(normalizedBase)}(?:/)?(?:[?#].*)?$`
    const fallbackMatch = exactMatch
      ? null
      : await RawItemModel.findOne(
          { "payload.url": { $regex: fallbackPattern, $options: "i" } },
          { itemMetaId: 1, "payload.url": 1, createdAt: 1 },
        )
          .sort({ createdAt: -1 })
          .lean()

    const resolvedRaw = exactMatch ?? fallbackMatch
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
    const confidence = exactMatch ? 1 : 0.86

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

    while (true) {
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

  private normalizeComparableUrl(
    value: string,
    options: { keepSearch: boolean },
  ): string | null {
    try {
      const parsed = new URL(value)
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return null
      }
      parsed.hash = ""
      parsed.hostname = parsed.hostname.toLowerCase()
      if (!options.keepSearch) {
        parsed.search = ""
      }
      if (parsed.pathname !== "/") {
        parsed.pathname = parsed.pathname.replace(/\/+$/, "")
      }
      const normalized = parsed.toString()
      return normalized.endsWith("/") && parsed.pathname === "/"
        ? normalized.slice(0, -1)
        : normalized
    } catch {
      return null
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
    sourceIds: Array<string | SourceID>,
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

  private async loadUserBehaviorSourceScores(orgId: string, userId: string) {
    const key = buildUserNewsBehaviorHashKey({
      orgId,
      userId,
      kind: "sources",
    })
    try {
      const raw = await this.cacheService.hgetall(key)
      return this.parseBehaviorScoreRecord(raw)
    } catch (error) {
      this.logger.warn(
        `behavior profile read failed for "${key}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return {}
    }
  }

  private parseBehaviorScoreRecord(raw: Record<string, string>) {
    const entries = Object.entries(raw ?? {})
      .map(([term, value]) => {
        const normalized = this.normalizeBehaviorTerm(term)
        if (!normalized) {
          return null
        }
        const score = Number(value)
        if (!Number.isFinite(score) || score <= 0) {
          return null
        }
        return [normalized, score] as const
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500)
    return Object.fromEntries(entries)
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
      await this.newsnowRealtime.publish({
        orgId,
        sourceId,
        newItemsCount,
        topTitles,
        updatedTime,
        intervalMs: Math.max(1_000, intervalMs),
      })
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
}
