// Package searchreindex serves the two search index rebuild endpoints migrated
// from NestJS:
//
//	POST /api/admin/search/reindex          (settings.manage, 201 queued job)
//	GET  /api/admin/search/reindex/:jobId   (settings.manage, 200 job or null)
//
// The unit owns the whole rebuild lifecycle: acquire the per-organization Redis
// lock, persist a queued job, return the queued snapshot, then run the rebuild
// in a service-lifetime goroutine (queued -> running -> completed/failed),
// persist the real indexed counter after every batch and prune the current
// organization's job history in the finally block.
//
// Redis layout is shared with SearchReindexJobStore:
//
//	search:reindex:job:<jobId>       job JSON (active TTL 12h, terminal TTL 1h)
//	search:reindex:org:<orgId>       RPUSH list of the organization's job ids
//	search:reindex:orgs              SADD set of organizations that own jobs
//	lock:search:reindex:org:<orgId>  SET NX PX lock (5 min, random owner token)
//
// The lock key carries the physical "lock:" prefix that CacheService adds, so it
// can never be confused with the organization job list. Renewal and release both
// compare the owner token, and renewal repeats every TTL/3 (~100s).
//
// The package is enabled by API_GO_SEARCH_REINDEX_MODE=go, which accepts only
// "", "legacy" and "go" and governs these two routes only; search telemetry
// keeps its own API_GO_CRAWL_READ_TELEMETRY_MODE switch. Elasticsearch settings
// are read from the same ELASTICSEARCH_* variables and defaults as the NestJS
// env schema. A disabled or unconfigured Elasticsearch keeps the existing
// disabled branch (indexed=0, no Mongo read), which is not a real rebuild.
//
// No process-restart resumption is implemented: job state survives in Redis,
// but nothing re-schedules a job that was interrupted by a crash.
package searchreindex
