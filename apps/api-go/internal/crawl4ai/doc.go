// Package crawl4ai ports the subset of apps/api/src/modules/crawl/crawl4ai.client.ts
// that the crawl discovery chain actually calls.
//
// Provenance: the request body, rendering/filter parameters, timeout resolution,
// authentication header, health check and result parsing mirror the NestJS
// client at apps/api/src/modules/crawl/crawl4ai.client.ts:145-408 and
// :850-1036 (toHttpPayload) and apps/api/src/modules/crawl/crawl4ai-proxy.ts.
// The Go type names are typed equivalents of the CrawlTaskOptions fields the
// payload builder reads.
//
// Request pacing and safety:
//   - Every outbound URL passes the shared SSRF rules of package newssources
//     (scheme, hostname, private IP ranges, cloud metadata endpoints and a
//     DNS-backed re-check) before the request is issued, exactly like the
//     NestJS validateRequestUrls. A blocked URL fails with HTTP 400 and the
//     message "URL blocked by SSRF protection: <reason>".
//   - The client never retries on its own. The two fallback requests it does
//     send (drop `prefetch` on a compatibility error, retry once with a bounded
//     virtualScroll when scanFullPage times out) are the ones the NestJS client
//     already performs; nothing beyond that is added.
//   - The caller supplies the crawl client settings (requestTimeoutNormalMs,
//     healthCheckTtlMs) so the run loop can share one settings read.
//
// Concurrency, circuit breaking and health state: the NestJS client keeps only
// one process-local value, `lastHealthCheck`, and skips GET /health while
// `now - lastHealthCheck < healthCheckTtlMs` (crawl4ai.client.ts:695-720). There
// is no semaphore, no circuit breaker and no Redis-backed health state in the
// client: concurrency is enforced by the BullMQ worker limit, and the
// per-target circuit breaker lives in crawl-execution-results.service.ts, which
// belongs to the crawl worker (out of scope for this batch). This Go client
// therefore keeps the same process-local TTL cache and nothing else, which means
// an api-go process issues its own /health probe at most once per TTL. That
// duplicates at most one cheap health request per TTL per process against
// crawl4ai; it does not change crawl traffic, because the discovery chain sends
// exactly the same /crawl requests either way.
package crawl4ai
