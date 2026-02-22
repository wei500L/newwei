import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common"

import { CacheService } from "../cache/cache.service"

import {
  BATCH_CONCURRENCY,
  BATCH_LIMIT,
  CACHE_PREFIX,
  MAX_ITEMS,
  STALE_TTL,
  Time,
} from "./news-aggregator.constants"
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import type { NewsItem, SourceID, SourceResponse } from "./news-aggregator.types"

@Injectable()
export class NewsAggregatorService {
  constructor(
    private readonly cacheService: CacheService,
    private readonly registryService: NewsAggregatorRegistryService,
  ) {}

  async fetchSource(id: string, forceRefresh: boolean = false): Promise<SourceResponse> {
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

    if (!forceRefresh) {
      const cached = await this.cacheService.get<SourceResponse>(cacheKey)
      if (cached) {
        return {
          ...cached,
          id: sourceId,
          status: "cache",
        }
      }
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
      const lockedResult = await this.cacheService.withLock(lockKey, 15_000, refresh)
      if (lockedResult) {
        return lockedResult
      }

      const afterLockCache = await this.cacheService.get<SourceResponse>(cacheKey)
      if (afterLockCache) {
        return {
          ...afterLockCache,
          id: sourceId,
          status: "cache",
        }
      }

      return await refresh()
    } catch (error) {
      const stale = await this.cacheService.get<SourceResponse>(staleKey)
      if (stale) {
        return {
          ...stale,
          id: sourceId,
          status: "cache",
        }
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
      const sourceId = batchIds[index]
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

  private normalizeItems(items: NewsItem[]): NewsItem[] {
    const normalized = items.filter((item) => {
      return Boolean(item)
        && item.id !== undefined
        && item.id !== null
        && typeof item.title === "string"
        && item.title.length > 0
        && typeof item.url === "string"
        && item.url.length > 0
    })

    return normalized.slice(0, MAX_ITEMS)
  }

  private buildCacheKey(sourceId: SourceID): string {
    return `${CACHE_PREFIX}:source:${sourceId}`
  }

  private buildStaleKey(sourceId: SourceID): string {
    return `${CACHE_PREFIX}:source:${sourceId}:stale`
  }
}
