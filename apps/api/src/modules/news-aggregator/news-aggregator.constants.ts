export const Time = {
  Realtime: 2 * 60 * 1000,
  Fast: 5 * 60 * 1000,
  Default: 10 * 60 * 1000,
  Common: 30 * 60 * 1000,
  Slow: 60 * 60 * 1000,
} as const

export const CACHE_PREFIX = "news-aggregator"
export const MAX_ITEMS = 50
export const BATCH_LIMIT = 100
export const BATCH_CONCURRENCY = 10
export const STALE_TTL = 24 * 60 * 60
export const REFRESH_LOCK_TTL_MS = 45 * 1000
