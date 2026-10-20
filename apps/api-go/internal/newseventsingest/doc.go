// Package newseventsingest owns the NewsEventsIngestionService Cron on the Go
// side: the five-minute tick, the active-organization fan-out with the
// per-organization lock, the ingestion cursor, the two ingestion modes
// (per-article assignment and bertopic_primary) and every write they perform.
//
// The chain is taken over only when API_GO_NEWS_EVENTS_INGESTION_MODE=go:
//
//	legacy  the NestJS Cron keeps owning the tick and nothing here runs.
//	go      this package claims cron:news-events-ingestion:tick-gate, takes
//	        cron:news-events-ingestion:org:<orgId> per organization and
//	        writes NewsEvent, NewsEventItem, NewsEventIngestionState, TaskLog
//	        and newseventclusteringfailures exactly like the NestJS original.
//
// Both sides use the same tick-gate key and the same organization lock key, so a
// mixed-version deployment never processes one organization twice in the same
// interval; the assignment itself is idempotent through the
// (orgId, processedArticleId) unique key and the in-transaction re-check.
//
// The equivalence rules this package follows were taken from the NestJS sources
// at apps/api/src/modules/news-events:
//
//   - news-events-ingestion.service.ts  the tick, ingestOrg and the cursor
//   - news-events.service.ts            assignNewsSignalToEvent and helpers
//   - news-events-bertopic.service.ts   processBatch and the chunking
//   - news-event-clustering-failure.service.ts recordFailure
//   - news-signals/news-signal.ts       buildNewsSignalFromProcessedArticle
//
// Deliberate behaviour change: the batch query adds a settle window
// (NEWS_EVENTS_INGESTION_SETTLE_MS, default 120000) so an article whose
// processing transaction commits after a later article can never be skipped by
// the cursor. See ingest.go.
package newseventsingest
