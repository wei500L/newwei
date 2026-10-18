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
// Media delivery has two branches, decided per record and never by the current
// global crawl_image_storage setting:
//
//   - mysql records are served as the signed binary body through the public
//     HMAC route (exp/org/user/sig, constant-time comparison, 30..86400 second
//     window) or as scoped HMAC preview/download URLs in the detail projection;
//   - s3 records are served as a 302 redirect to an AWS SDK presigned GET built
//     from the record's own storageKey, with the normalized response content
//     type, the inline/attachment disposition and "private, max-age=300" cache
//     control participating in the signature. The detail projection signs the
//     preview and download URLs independently, so a signing failure omits only
//     that URL and keeps the asset. The service never downloads the media and
//     never HEADs the object.
//
// The storage configuration snapshot is read once per detail request (clamped
// TTL plus one signing client) and once per media request; it is never re-read
// per asset or per mode.
//
// The write queue (POST /api/crawl-tasks, DELETE /api/crawl-tasks/:id, POST
// /api/crawl-tasks/:id/retry, POST /api/crawl-tasks/metadata) and the live
// crawler administration surface (/api/admin/crawl4ai/queue*) are never served
// here; the legacy proxy keeps them on NestJS.
package crawlreadtelemetry
