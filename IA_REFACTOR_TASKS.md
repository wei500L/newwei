# Public IA Refactor Tasks

## IA & Page Restructure
- [x] Navigation: separate public tasks from admin/ops tools and add a visual admin label.
- [x] Today: keep published-first ordering, show summary + quality/duplicate cues, and adjust empty-state copy.
- [x] Topics & Events: sort by published_at where available, keep timeline ordering consistent, and use "aggregation insufficient" empty states.
- [x] Map: default 30-day range, label signals clearly, and show "no alerts triggered" empty state.
- [x] Finance: add public market overview (hero metrics + sector heatmap + candlestick) tied to dashboard time range; show no-data empty states instead of demo values.
- [x] Alerts: list newest first and show "no recent alerts" empty state.
- [x] Search: keep list ordering consistent and add explicit service-unavailable error state.
- [x] Subscriptions: default to recent + unread notifications and highlight unread items.
- [x] Admin: move admin/ops entry into a visually separated group.

## Inventory & Feature Verification (no code changes)
- [x] Front-end routes/layout ownership confirmed.
- [x] Theme and chart container consistency confirmed.
- [x] State management and data clients confirmed.
- [x] API surface (GraphQL + REST) confirmed.
- [x] Data models (MySQL + Mongo) confirmed.
- [x] Scheduling/queue pipeline confirmed.
- [x] Crawl + AI pipeline confirmed.
- [x] Auth/RBAC/rate limit middleware confirmed.
- [x] Observability/config/deploy assets confirmed.
- [x] Feature gaps documented: sentiment/risk scoring, vector search, relation graph, backtesting engine, dedicated risk model, explicit CSRF/CSP headers.
