# Product Refactor Task Breakdown

## Scope
This document expands the execution plan into implementable tasks with explicit ownership boundaries, dependencies, and acceptance criteria. It assumes no mock data and uses only existing pipelines and persisted sources.

## Workstream W0 - Data Contract and Time Semantics

### W0.T1 - Field Dictionary and Ownership Map
- Objective: Establish a canonical field dictionary and ownership rules across RawItem, ProcessedItem, Article, ProcessedArticle, ItemMeta.
- Files:
  - packages/mongo/src/models/raw-item.ts
  - packages/mongo/src/models/processed-item.ts
  - packages/db/prisma/schema.prisma
  - apps/api/src/modules/news-pipeline/news-pipeline.schema.ts
- Steps:
  - Enumerate all fields and define authoritative source per field.
  - Document fallback rules and nullability.
  - Mark unavailable fields explicitly.
- Acceptance:
  - Dictionary lists title, summary, topics, entities, source, publishedAt, language, quality_score, duplicateOf.
  - All UI fields map to this dictionary.
- Validation:
  - Review with pipeline and web owners.

### W0.T2 - Time Semantics and Labeling Rules
- Objective: Define publishedAt vs crawlAt vs createdAt usage across API and UI.
- Files:
  - apps/api/src/modules/news-pipeline/news-pipeline.service.ts
  - apps/web/lib/dayjs.ts
- Steps:
  - Document precedence rules and required UI labels.
  - Define timezone normalization policy.
- Acceptance:
  - UI never silently substitutes one timestamp for another.

## Workstream W1 - Items Read Model and API Shape

### W1.T1 - Canonical Item Read Model
- Objective: Expose structured processed fields in GraphQL and remove JSON parsing in the web layer.
- Files:
  - apps/api/src/graphql/models/item.model.ts
  - apps/api/src/graphql/resolvers/items.resolver.ts
  - apps/api/src/graphql/loaders/processed-item.loader.ts
  - apps/web/graphql/items.graphql
- Steps:
  - Introduce a structured GraphQL type for processed result fields.
  - Map Mongo processed result to GraphQL fields directly.
  - Update query schema and regenerate types.
- Acceptance:
  - Web layer does not JSON.parse processed result or raw payload.
  - Structured fields are available in Items query.
- Validation:
  - GraphQL introspection shows new fields.
  - Items page renders without JSON parsing.

### W1.T2 - Item Status Alignment
- Objective: Ensure ItemMeta status reflects pipeline completion and failure states.
- Files:
  - apps/api/src/modules/news-pipeline/news-pipeline.service.ts
  - apps/api/src/modules/items/items.service.ts
  - packages/db/prisma/schema.prisma
- Steps:
  - Define explicit status transitions.
  - Update pipeline to set status for completed and failed states.
- Acceptance:
  - Items with completed processing are marked consistently.

## Workstream W2 - Server-side Filtering and Search

### W2.T1 - GraphQL Filters for Items
- Objective: Support date range, tags, topics, language, status filters in Items query.
- Files:
  - apps/api/src/graphql/dto/item.input.ts
  - apps/api/src/modules/items/items.service.ts
- Steps:
  - Add filter inputs to GraphQL args.
  - Implement server-side filtering using Prisma and Mongo data.
- Acceptance:
  - Filtered count matches list results.
  - Pagination remains stable.
- Validation:
  - Add integration tests for filters and pagination.

### W2.T2 - Search Scope Expansion
- Objective: Improve search consistency across title and summary fields.
- Files:
  - apps/api/src/modules/items/items.service.ts
- Steps:
  - Keep existing fulltext for ItemMeta fields.
  - Add optional summary-based search path where feasible.
- Acceptance:
  - Search results are explainable and deterministic.

## Workstream W3 - Dashboard Metric Integrity

### W3.T1 - Remove Demo Metrics in Production
- Objective: Prevent demo data from being injected in production.
- Files:
  - apps/api/src/modules/dashboard/dashboard-demo-metrics.service.ts
  - packages/config/src/demo-metrics.ts
- Steps:
  - Ensure demo data only populates non-production environments.
- Acceptance:
  - Production dashboards never include demo metrics.

### W3.T2 - War Map Semantics
- Objective: Align war map with real data semantics or label as metric overlay.
- Files:
  - apps/api/src/modules/dashboard/dashboard-charts.service.ts
  - apps/web/app/(app)/dashboard/charts/war-map.tsx
- Steps:
  - Define data provenance labeling.
- Acceptance:
  - UI indicates data source and meaning clearly.

## Workstream W4 - Economic Data Field Mapping

### W4.T1 - Field Mapping Configuration
- Objective: Replace hardcoded field names with configurable mappings.
- Files:
  - apps/api/src/modules/akshare/akshare.service.ts
  - packages/db/prisma/schema.prisma
  - apps/web/hooks/useEconomicData.ts
  - apps/web/app/(app)/dashboard/utils/series.ts
- Steps:
  - Add metadata mapping for sourceField to display labels.
  - Update series utils to use mapping.
- Acceptance:
  - Economic pages render without hardcoded field names.

### W4.T2 - Empty and Error State Consistency
- Objective: Standardize empty and error states across charts.
- Files:
  - apps/web/components/chart-empty-state.tsx
  - apps/web/app/(app)/dashboard/components
- Acceptance:
  - No chart renders zeros for missing data.

## Workstream W5 - Public-facing IA and UX

### W5.T1 - Navigation Restructure
- Objective: Shift navigation to public-facing tasks and isolate admin tools.
- Files:
  - apps/web/app/(app)/components/top-nav.tsx
  - apps/web/app/(app)/components/shell.tsx
  - apps/web/app/page.tsx
- Acceptance:
  - Top-level nav is Today, Topics, Map, Finance, Alerts, Search, Subscriptions.
  - Admin tools remain behind permissions.

### W5.T2 - Today Feed Card Design
- Objective: Provide readable cards with canonical fields only.
- Files:
  - apps/web/app/(app)/items/items-view.tsx
  - apps/web/app/(app)/items/components/news-card.tsx
- Acceptance:
  - Cards show title, summary, source, publishedAt with labels.

### W5.T3 - Visual System Re-baseline
- Objective: Move from neon admin styling to reading-first palette and typography.
- Files:
  - apps/web/app/globals.css
  - apps/web/tailwind.config.ts
  - apps/web/app/layout.tsx
- Acceptance:
  - Improved readability and contrast for long-form text.

### W5.T4 - Right-rail Stream Labeling
- Objective: Align stream name with actual data source.
- Files:
  - apps/web/app/(app)/dashboard/components/breaking-news-stream.tsx
- Acceptance:
  - Stream title and content source match.

## Workstream W6 - Alerts Productization

### W6.T1 - Evidence and Rationale in Alert UI
- Objective: Provide alert context and reasoning to users.
- Files:
  - apps/api/src/modules/alerts/alerts.service.ts
  - apps/web/app/(app)/dashboard/alert-panel.tsx
- Acceptance:
  - Alerts display metric, threshold, change window, and source.

### W6.T2 - Subscription Management
- Objective: Make channel configuration accessible and auditable.
- Files:
  - apps/web/app/(app)/dashboard/alert-config-form.tsx
  - apps/api/src/modules/alerts
- Acceptance:
  - Users can manage channel targets and status.

## Workstream W7 - Observability and Reliability

### W7.T1 - Persist Exception Events
- Objective: Ensure error events survive restarts and support pagination.
- Files:
  - apps/api/src/modules/observability/exception-events.service.ts
  - apps/web/app/(app)/admin/errors/errors-content.tsx
- Acceptance:
  - Error list persists across restarts.

### W7.T2 - Data Quality Metrics
- Objective: Expose crawl and pipeline health metrics.
- Files:
  - packages/mongo/src/models/task-log.ts
  - apps/api/src/modules/queue
- Acceptance:
  - Metrics for pipeline success rate and dedupe rate are available.

## Workstream W8 - Source Management (Optional)

### W8.T1 - NewsSource CRUD and Scheduling
- Objective: Operationalize NewsSource with frequency and priority.
- Files:
  - packages/db/prisma/schema.prisma
  - apps/api/src/modules/crawl
  - apps/api/src/modules/news-pipeline
- Acceptance:
  - Sources can be enabled or disabled and scheduled.

### W8.T2 - PipelineJob Lifecycle
- Objective: Track job status and retries for each source.
- Files:
  - packages/db/prisma/schema.prisma
  - apps/api/src/modules/queue
- Acceptance:
  - Jobs have explicit states and retry policies.

## Cross-cutting Validation
- Add integration tests for Items filters and pagination.
- Add unit tests for status transitions and dedupe handling.
- Verify chart rendering with real data subsets.

## Suggested Start Order
1) W0.T1 and W0.T2
2) W1.T1 and W1.T2
3) W2.T1 and W2.T2
4) W3 and W4
5) W5
6) W6
7) W7
8) W8 (optional)
