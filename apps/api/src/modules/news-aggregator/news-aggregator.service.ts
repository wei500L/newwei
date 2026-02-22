import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"

import { CacheService } from "../cache/cache.service"

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
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import type { NewsItem, SourceID, SourceResponse } from "./news-aggregator.types"

@Injectable()
export class NewsAggregatorService {
  private readonly logger = new Logger(NewsAggregatorService.name)

  constructor(
    private readonly cacheService: CacheService,
    private readonly registryService: NewsAggregatorRegistryService,
  ) {}

  async fetchSource(id: string): Promise<SourceResponse> {
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

    const cached = await this.safeGetCache<SourceResponse>(cacheKey)
    if (cached) {
      return { ...cached, id: sourceId, status: "cache" }
    }

    const refresh = async (): Promise<SourceResponse> => {
      const items = this.normalizeItems(await getter())
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
        return { ...polled, id: sourceId, status: "cache" }
      }

      // Poll timed out — try stale fallback instead of redundant refresh
      const stale = await this.safeGetCache<SourceResponse>(staleKey)
      if (stale) {
        this.logger.warn(`lock contention for "${sourceId}", serving stale data`)
        return { ...stale, id: sourceId, status: "cache" }
      }

      // No stale data available — last resort, do the refresh
      return await refresh()
    } catch (error) {
      this.logger.warn(`source refresh failed for "${sourceId}": ${error instanceof Error ? error.message : String(error)}`)

      const stale = await this.safeGetCache<SourceResponse>(staleKey)
      if (stale) {
        return { ...stale, id: sourceId, status: "cache" }
      }

      throw error
    }
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
}
