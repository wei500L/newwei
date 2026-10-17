// Package classificationrssops implements the Go takeover of the classification
// quality workbench, the RSS chain diagnostics and the RSS translation daily
// metrics. It is registered by cmd/api only when
// API_GO_CLASSIFICATION_RSS_OPS_MODE=go.
//
// Sources of truth (translated statement by statement, never a simplified
// reimplementation):
//
//   - apps/api/src/modules/observability/classification-quality.controller.ts
//   - apps/api/src/modules/observability/classification-quality.service.ts
//   - apps/api/src/modules/observability/classification-quality.dto.ts
//   - apps/api/src/modules/news-pipeline/news-classification-quality-settings.service.ts
//   - apps/api/src/modules/news-events/news-event-source-classifier.ts
//   - apps/api/src/modules/system-settings/rss-diagnostics.controller.ts
//   - apps/api/src/modules/system-settings/rss-diagnostics.service.ts
//   - apps/api/src/modules/system-settings/rss-translation-metrics.controller.ts
//   - apps/api/src/modules/system-settings/rss-translation-metrics.service.ts
//   - apps/api/src/modules/observability/observability-snapshot.service.ts
//   - packages/mongo/src/models/classification-*.ts, processed-item.ts, raw-item.ts,
//     task-log.ts (default collection names processeditems / tasklogs / rawitems /
//     classificationreviews / classificationsamples / classificationannotations /
//     classificationreportjobs / classificationreportresults)
//
// Every Mongo document, MySQL row, request body and response body in this
// package is a named struct with exact bson / json tags. Request DTOs are never
// decoded into untyped bags and no value is carried through an untyped alias or
// container type: MySQL statements keep a fixed arity (id lists are matched with
// JSON_CONTAINS) and Mongo documents are decoded into typed structs.
//
// The 13 route rules migrated here are declared in
// internal/legacyproxy/classification_rss_ops_routes.go. POST
// /api/admin/quality/classification/reports is deliberately not part of the
// takeover: it enqueues a BullMQ job and stays on NestJS.
package classificationrssops
