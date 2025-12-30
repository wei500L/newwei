# Product Refactor Execution Plan

## Purpose
Deliver a production-grade, public-facing information product without changing the core business goals (AI news processing, global monitoring, financial analysis, visualization, alerting, security). The plan prioritizes data correctness and interface stability first, then IA and UX, then reliability and alert productization.

## Hard Constraints
- No mock data, hardcoded articles, or static arrays used to simulate results.
- All UI and metrics must be backed by existing data flow and persisted sources.
- Changes must preserve multi-tenant boundaries and RBAC.

## Repository Baseline (Source of Truth)
- News pipeline: apps/api/src/modules/news-pipeline
- Crawling orchestration: apps/api/src/modules/crawl
- Items API and GraphQL: apps/api/src/modules/items, apps/api/src/graphql/resolvers/items.resolver.ts
- Economic data: apps/api/src/modules/akshare, apps/api/src/graphql/resolvers/economic-data.resolver.ts
- Alerts: apps/api/src/modules/alerts
- Notifications: apps/api/src/modules/notifications
- Observability: apps/api/src/modules/observability
- Primary DB (Prisma MySQL): packages/db/prisma/schema.prisma
- Mongo models: packages/mongo/src/models
- Web app routes: apps/web/app/(app)
- Web charts and data hooks: apps/web/app/(app)/dashboard, apps/web/hooks

## Execution Principles
- Data correctness before UI changes.
- Build a canonical read model for the web layer.
- Prefer backend aggregation over client-side parsing.
- Ship in small, reversible slices.

## Phase 0 - Discovery and Schema Alignment
Goal: lock down field semantics and data ownership.

Tasks:
- D0.1 Create a field dictionary for RawItem, ProcessedItem, Article, ProcessedArticle, ItemMeta.
  - Files: packages/mongo/src/models/raw-item.ts, packages/mongo/src/models/processed-item.ts, packages/db/prisma/schema.prisma
  - Output: authoritative mapping for title, summary, topics, entities, publishedAt, source, language, quality_score, duplicateOf.
  - Acceptance: all UI fields are mapped or marked as unavailable.

- D0.2 Define time semantics and fallback rules.
  - Files: apps/api/src/modules/news-pipeline/news-pipeline.service.ts
  - Output: publishedAt vs crawlAt vs createdAt usage rules.
  - Acceptance: UI labels show time source and never mix silently.

Risks:
- Hidden usage of JSON strings in GraphQL responses.

## Phase 1 - Data Integrity and API Shape
Goal: remove client-side parsing and enforce stable contract.

Tasks:
- D1.1 Align Item status transitions with pipeline outcomes.
  - Files: apps/api/src/modules/news-pipeline/news-pipeline.service.ts, apps/api/src/modules/items/items.service.ts
  - Acceptance: status moves to completed or failed; duplicates marked consistently.

- D1.2 Add a canonical Item read model in GraphQL.
  - Files: apps/api/src/graphql/models/item.model.ts, apps/api/src/graphql/resolvers/items.resolver.ts
  - Output: structured fields instead of JSON strings for processed result.
  - Acceptance: web layer does not JSON.parse processed result or raw payload.

- D1.3 Server-side filters and pagination for Items.
  - Files: apps/api/src/graphql/dto/item.input.ts, apps/api/src/modules/items/items.service.ts
  - Filters: date range, tags, topics, language, status.
  - Acceptance: filtered count matches list; pagination is stable.

- D1.4 Search scope upgrade.
  - Files: apps/api/src/modules/items/items.service.ts
  - Output: fulltext on title and externalId remains, add optional fields in processed summary where feasible.
  - Acceptance: search hits are explainable and consistent.

Risks:
- Cross-store join complexity between Prisma and Mongo.

## Phase 2 - Visualization Integrity
Goal: remove demo paths and stabilize chart semantics.

Tasks:
- V2.1 Remove demo metrics in production mode.
  - Files: apps/api/src/modules/dashboard/dashboard-demo-metrics.service.ts, packages/config/src/demo-metrics.ts
  - Acceptance: production never auto-inserts demo data.

- V2.2 Re-label war map as metric overlay or replace with real geo events.
  - Files: apps/api/src/modules/dashboard/dashboard-charts.service.ts, apps/web/app/(app)/dashboard/charts/war-map.tsx
  - Acceptance: UI clarifies data source and meaning.

- V2.3 Normalize economic field mapping.
  - Files: apps/api/src/modules/akshare/akshare.service.ts, apps/web/hooks/useEconomicData.ts, apps/web/app/(app)/dashboard/utils/series.ts
  - Output: mapping rules stored in data metadata or config.
  - Acceptance: charts do not depend on hardcoded field names.

- V2.4 Unify empty and error states for charts.
  - Files: apps/web/components/chart-empty-state.tsx, apps/web/app/(app)/dashboard/components
  - Acceptance: missing data never renders as zero values.

Risks:
- Missing sourceField values for some economic series.

## Phase 3 - Public-facing IA and UX
Goal: shift from admin console to reading-focused product.

Tasks:
- U3.1 Top-level navigation restructure.
  - Files: apps/web/app/(app)/components/top-nav.tsx, apps/web/app/(app)/components/shell.tsx, apps/web/app/page.tsx
  - Output: navigation for Today, Topics, Map, Finance, Alerts, Search, Subscriptions.
  - Acceptance: admin-only tools are isolated under Settings or Admin.

- U3.2 Today feed and card layout.
  - Files: apps/web/app/(app)/items/items-view.tsx, apps/web/app/(app)/items/components/news-card.tsx
  - Acceptance: cards show only real fields with stable time labeling.

- U3.3 Visual system shift to reading-first.
  - Files: apps/web/app/globals.css, apps/web/tailwind.config.ts, apps/web/app/layout.tsx
  - Acceptance: typography and color contrast improve readability; no neon-only scheme.

- U3.4 Align right-rail content labels with actual data.
  - Files: apps/web/app/(app)/dashboard/components/breaking-news-stream.tsx
  - Acceptance: label matches actual source (analysis stream vs news stream).

Risks:
- Design changes may impact existing admin workflows.

## Phase 4 - Alerts Productization
Goal: make alerting explainable and subscription-friendly.

Tasks:
- A4.1 Evidence and rationale for alerts.
  - Files: apps/api/src/modules/alerts/alerts.service.ts, apps/web/app/(app)/dashboard/alert-panel.tsx
  - Output: show metric, threshold, change window, source.
  - Acceptance: each alert is traceable to a specific rule and measurement.

- A4.2 Subscription management UX.
  - Files: apps/web/app/(app)/dashboard/alert-config-form.tsx, apps/api/src/modules/alerts
  - Acceptance: users can manage channels with clear status and cooldowns.

- A4.3 Feedback loop for false positives.
  - Files: packages/db/prisma/schema.prisma, apps/api/src/modules/alerts
  - Acceptance: rule metadata captures feedback and audit history.

Risks:
- Overloading alert metadata without schema governance.

## Phase 5 - Reliability and Observability
Goal: ensure long-term stability and auditability.

Tasks:
- R5.1 Persist exception events.
  - Files: apps/api/src/modules/observability/exception-events.service.ts, apps/web/app/(app)/admin/errors/errors-content.tsx
  - Acceptance: error list survives restarts and supports pagination.

- R5.2 Data quality dashboard.
  - Files: apps/api/src/modules/queue, packages/mongo/src/models/task-log.ts
  - Acceptance: quality metrics available for crawl success, pipeline completion, dedupe rate.

- R5.3 Performance budgets and caching.
  - Files: apps/web/lib/apollo-client.ts, apps/web/lib/api-client.ts, apps/api/src/modules/cache
  - Acceptance: dashboard and items pages meet latency and error-rate targets.

Risks:
- Partial metrics if TaskLog coverage is incomplete.

## Phase 6 - Source Management (Optional Extension)
Goal: operationalize NewsSource and PipelineJob.

Tasks:
- S6.1 Implement NewsSource CRUD and scheduling.
  - Files: packages/db/prisma/schema.prisma, apps/api/src/modules/crawl, apps/api/src/modules/news-pipeline
  - Acceptance: sources can be enabled/disabled with frequency and priority.

- S6.2 PipelineJob lifecycle and retries.
  - Files: packages/db/prisma/schema.prisma, apps/api/src/modules/queue
  - Acceptance: jobs have clear states and retry rules with audit logs.

Risks:
- Additional queue load and scaling complexity.

## Acceptance Gates
- Gate 1: Items UI uses only canonical fields, no JSON.parse in the web layer.
- Gate 2: Dashboards show only real data or explicit labels if synthetic.
- Gate 3: Alerts provide evidence and are auditable.
- Gate 4: Observability data persists across restarts.

## Validation Plan
- Add or update unit tests for pipeline status transitions.
- Add integration tests for Items query filters and pagination.
- Add UI validation for empty/error states and time labeling.
- Review data correctness with sample records in Mongo and MySQL.

## Risks and Mitigations
- Cross-database joins: mitigate by building a backend read model with batched loaders.
- Field drift: mitigate by enforcing field dictionary and rejecting unknown fields.
- UI regressions: mitigate by feature flags or route-level rollout.

## Rollout Strategy
- Phase-by-phase delivery with gated release notes.
- Keep admin tools available under protected routes while public IA ships.
- Maintain backward compatibility for existing GraphQL queries during transition.
