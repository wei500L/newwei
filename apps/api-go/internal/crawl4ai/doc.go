// Package crawl4ai ports the subset of apps/api/src/modules/crawl/crawl4ai.client.ts
// that the crawl discovery chain calls.
//
// Provenance: the request body builder mirrors Crawl4aiClient.toHttpPayload
// (crawl4ai.client.ts:850-1036), the timeout resolution mirrors
// resolveRequestTimeoutMs (:370-390), the authentication header and the fixups
// mirror sendCrawlRequest (:392-408), the health probe mirrors ensureHealthy
// (:695-720), the URL guard mirrors validateRequestUrls (:824-848) and the two
// fallbacks mirror buildPrefetchCompatibilityFallbackPayload (:438-470) and
// buildScanFullPageFallbackPayload (:472-551). The crawl-options normalization
// mirrors CrawlOptionsNormalizerService.normalizeOptions
// (crawl-options-normalizer.service.ts:268-489) for the fields the request body
// reads.
//
// Request pacing and safety:
//   - Every outbound URL passes the shared SSRF rules of package newssources
//     (scheme, hostname, private IP ranges, cloud metadata endpoints and a
//     DNS-backed re-check) before the request is issued, exactly like the
//     NestJS validateRequestUrls pair. A blocked URL fails with HTTP 400 and
//     the message "URL blocked by SSRF protection: <reason>".
//   - The client never retries on its own. The two fallback requests it does
//     send (drop `prefetch` on a compatibility error, retry once with a bounded
//     virtualScroll when scanFullPage times out) are the ones the NestJS client
//     already performs; nothing beyond that is added.
//
// Not ported (documented, not silently dropped):
//   - User-agent auto-generation (user_agent_mode "random") and browser
//     geolocation: the discovery chain never sets them and the NestJS random
//     agent differs per request anyway, so no stable payload exists to match.
//   - Media/table/multi-URL defaults: multi-URL configurations and custom
//     proxies are rejected before the request is built (crawl-config-policy
//     assertNoUnsupportedProxy), and the discovery chain reads only `url`,
//     `success` and `links`, so those defaults cannot change the candidate set.
//
// Concurrency and health state: the NestJS client keeps only one process-local
// value, `lastHealthCheck`, and skips GET /health while `now - lastHealthCheck <
// healthCheckTtlMs` (crawl4ai.client.ts:695-720). There is no semaphore, no
// circuit breaker and no Redis-backed health state in the client: concurrency is
// enforced by the BullMQ worker limit, and the per-target circuit breaker lives
// in crawl-execution-results.service.ts, which belongs to the crawl worker (out
// of scope for this batch). This Go client therefore keeps the same
// process-local TTL cache and nothing else, so an api-go process issues its own
// /health probe at most once per TTL. `semaphore_count` is a crawl4ai
// server-side parameter and is forwarded in the body, never used as a client
// concurrency limit.
package crawl4ai
