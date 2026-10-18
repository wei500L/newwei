// Package infrastructuresettings implements the Go takeover of the seven
// infrastructure connection and crawl-credential settings HTTP routes:
//
//	GET    /api/system-settings/vector-service
//	PUT    /api/system-settings/vector-service
//	DELETE /api/system-settings/vector-service
//	GET    /api/admin/settings/storage
//	PATCH  /api/admin/settings/storage
//	GET    /api/system-settings/news-source-runtime-secrets
//	PUT    /api/system-settings/news-source-runtime-secrets
//
// The package is wired only when API_GO_INFRASTRUCTURE_SETTINGS_MODE=go; the
// default (legacy, including the empty value) keeps every request on the
// NestJS proxy, so rollback is a single environment-variable change.
//
// The package also backs two things that are not part of those seven routes:
//
//   - StorageRuntimeConfig, the named runtime storage configuration snapshot
//     consumed by the crawl media signing paths and by the diagnostics handler.
//     It reuses the same nine SystemSetting rows, the same `storage:settings`
//     Redis entry (60 second TTL, database fallback) and the same secret
//     decryption; the masked admin display model is never used as business
//     configuration;
//   - POST /api/admin/settings/storage/test, the real storage connection test,
//     which has its own independent API_GO_STORAGE_DIAGNOSTICS_MODE switch
//     (legacy by default) and requires only settings.manage — no platform-admin
//     second gate. mode=mysql runs SELECT 1; mode=s3 runs HeadBucket, PutObject
//     and DeleteObject with one unique probe key per run and reports every step
//     in the response body (HTTP 201 with ok:false when a step fails).
//
// The implementation mirrors the NestJS contract one-for-one:
//
//   - authentication is the shared authhttp chain (JWT verification, Redis
//     blacklist, MySQL membership re-derivation) plus the mtk_ machine-token
//     path, which reuses the same SHA-256 lookup as the other Go domains;
//   - the four write routes additionally require a real platform admin
//     (GlobalRoleAssignment.userId, role = platform_admin). A machine token can
//     never satisfy that gate because its actor id is not a User row;
//   - reads accept the same stored JSON shapes as Prisma, including values
//     that are not valid encryption payloads, and degrade exactly like NestJS;
//   - writes upsert the same SystemSetting primary keys, keep the same field
//     order in the JSON column, and write the same best-effort AuditLog rows
//     through the AuditLogOutbox fallback.
//
// Every request and response model is a named struct with explicit json tags.
// JSON values that are inherently schema-less (a stored SystemSetting.value, a
// Redis cache entry) are handled as json.RawMessage bytes and decoded into
// named structs immediately; the package never uses any / interface{} /
// map[string]any.
//
// What deliberately stays on NestJS: GET /api/system-settings/vector-service/
// diagnostics (it reports the NestJS process's vector client counters), every
// vector search/upsert/dedupe/backfill path, every other S3 object operation
// (avatar uploads, crawl media writes and deletes, cleanup), the actual
// news-source fetch chain that consumes getSecretsForSource, and all GraphQL,
// BullMQ and scheduler work.
package infrastructuresettings
