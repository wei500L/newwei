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
// diagnostics (it reports the NestJS process's vector client counters),
// POST /api/admin/settings/storage/test (it performs real S3 calls), every
// vector search/upsert/dedupe/backfill path, every S3 object operation, the
// actual news-source fetch chain that consumes getSecretsForSource, and all
// GraphQL, BullMQ and scheduler work.
package infrastructuresettings
