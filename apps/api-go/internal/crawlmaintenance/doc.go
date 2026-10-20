// Package crawlmaintenance owns the five background maintenance crons that
// NestJS used to run on every API instance:
//
//   - the crawl task janitor (stale running / queued / pending tasks),
//   - the cleanup_crawl_results MongoOutbox replay,
//   - the crawl adaptive concurrency adjustment,
//   - the crawl quality task snapshot refresh,
//   - the audit log retention purge.
//
// Execution ownership is decided by two environment switches
// (API_GO_CRAWL_MAINTENANCE_MODE for the first four, and
// API_GO_AUDIT_LOG_RETENTION_MODE for the purge). While a switch is legacy the
// NestJS @Cron callback keeps running; when it is go NestJS returns from the
// callback before taking any lock and this package runs the work.
//
// A switch flip can leave both processes alive for a few seconds. Every unit
// therefore shares the exact Redis key with its NestJS counterpart:
// CacheService.withLock("cron:...") becomes the physical key "lock:cron:...",
// and the quality snapshot tick gate is a bare "cron:...:tick-gate" key. The
// audit purge (B5) takes a lock NestJS does not take, but its DELETE is
// idempotent and both processes only remove createdAt < cutoff rows.
//
// All writes keep the NestJS contract: CrawlTask.status/lastError, AuditLog
// rows and their outbox fallback, TaskLog documents, MongoOutbox status and
// backoff, CrawlQualityTaskSnapshot rows, the crawl:activity hash, the adaptive
// state JSON and the crawl:worker-concurrency:v1 broadcast.
package crawlmaintenance

// Redis keys shared with NestJS. The "lock:" prefix is applied by
// CacheService.withLock, not part of the caller key.
const (
	janitorLockKey        = "cron:crawl-task-janitor"
	cleanupOutboxLockKey  = "cron:crawl-cleanup-outbox"
	adaptiveLockKey       = "cron:crawl-adaptive-concurrency"
	qualityTickGateKey    = "cron:crawl-quality-task-snapshot:tick-gate"
	qualityOrgLockPrefix  = "cron:crawl-quality-task-snapshot:org:"
	auditRetentionLockKey = "cron:audit-log-retention"
	adaptiveStateCacheKey = "crawl:adaptive-concurrency:state"
	adaptiveStateTTL      = 7 * 24 * 60 * 60
	activeOrgsCacheKey    = "org:active:list:v1"
	activeOrgsCacheTTL    = 15
)
