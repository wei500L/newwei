// Package crawlreadtelemetry implements the seven crawl read, media delivery
// and search telemetry HTTP endpoints taken over by apps/api-go when
// API_GO_CRAWL_READ_TELEMETRY_MODE=go.
//
// The package mirrors the NestJS contract byte for byte:
//
//	GET  /api/crawl-tasks                             (crawl.read)
//	GET  /api/crawl-tasks/:id                         (crawl.read)
//	GET  /api/crawl-media-assets/:assetId/:mode       (@Public + HMAC signature)
//	GET  /api/admin/crawl4ai/quality                  (crawl.read)
//	GET  /api/admin/crawl4ai/quality/sources/:sourceId (crawl.read)
//	POST /api/search-telemetry                        (items.read)
//	GET  /api/admin/search-telemetry/summary          (settings.manage)
//
// Every exported type and function carries precise json / bson tags or an
// explicit schema; the package never uses any, interface{}, map[string]any or
// []any to carry request DTOs, response models, Mongo documents or Redis
// telemetry payloads. Schema-less JSON (Mongoose Mixed fields and Prisma Json
// columns) is carried by the strongly typed RawJSON wrapper.
//
// The write queue (POST /api/crawl-tasks, DELETE /api/crawl-tasks/:id, POST
// /api/crawl-tasks/:id/retry, POST /api/crawl-tasks/metadata) and the live
// crawler administration surface (/api/admin/crawl4ai/queue*) are never served
// here; the legacy proxy keeps them on NestJS.
package crawlreadtelemetry
