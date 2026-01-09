# Backend & Data Pipeline Reliability Tasks

This checklist tracks the reliability upgrades described in the “后端与数据管道可靠性改造建议” note and the corresponding implementation in this repo.

## Crawlers & Scheduling

- [x] **NewsSource failure retry + source-level circuit breaker**
  - DB: `NewsSource` now tracks `consecutiveFailures`, `lastFailureAt`, `lastSuccessAt`, `circuitOpenUntil`.
  - Behavior: final pipeline failures backoff with jitter + optionally open a circuit after a threshold.
  - Config: `.env.example` includes circuit/backoff knobs.
  - API metric: `GET /admin/quality/news-sources` (requires `settings.manage`).

- [x] **Crawl4ai options template library + UI**
  - DB: new `CrawlTemplate` model with `crawlOptions` JSON and `isActive` toggle.
  - API: CRUD at `admin/crawl-templates` (requires `crawl.read`/`crawl.write`).
  - UI: `apps/web/app/(app)/admin/ops/crawl-templates`.
  - News sources can reference a template via `crawlTemplateId`; scheduler merges template options + per-source overrides.

## Database & Search

- [x] **Semantic (vector) search for items**
  - Uses LiteLLM embeddings + cosine similarity against stored `summaryEmbedding` vectors in Mongo.
  - Cached per-org query results via Redis.

- [x] **Hot topics/events caching**
  - `topicGroups` / `eventGroups` responses cached in Redis with short TTL to reduce repeated heavy aggregations.

## AI Pipeline Reliability

- [x] **Processing state “state machine” + replay/rollback endpoints**
  - State is derived from `TaskLog` stage events + `ProcessedItem` status.
  - API:
    - `GET /admin/quality/pipeline/runs?itemMetaId=...`
    - `POST /admin/quality/pipeline/replay`
    - `POST /admin/quality/pipeline/rollback`

## Observability

- [x] **Data quality dashboard + ingestion latency monitoring**
  - API: `GET /admin/quality/pipeline` now includes ingestion latency percentiles.
  - UI: `apps/web/app/(app)/admin/quality`.

