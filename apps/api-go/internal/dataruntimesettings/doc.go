// Package dataruntimesettings implements the Go takeover of the nine
// "data runtime settings and archive status" HTTP routes:
//
//	GET    /api/system-settings/realtime-signals
//	PUT    /api/system-settings/realtime-signals
//	DELETE /api/system-settings/realtime-signals
//	GET    /api/system-settings/archive-preparation
//	PUT    /api/system-settings/archive-preparation
//	DELETE /api/system-settings/archive-preparation
//	GET    /api/admin/archive-preparation/status
//	GET    /api/system-settings/geo/nominatim
//	PUT    /api/system-settings/geo/nominatim
//
// The package is wired only when API_GO_DATA_RUNTIME_SETTINGS_MODE=go; the
// default (legacy, including the empty value) keeps every request on the NestJS
// proxy, so rollback is a single environment-variable change.
//
// The implementation mirrors the NestJS contract one-for-one:
//
//   - authentication is the shared authhttp chain (JWT verification, Redis
//     blacklist, MySQL membership re-derivation) plus the mtk_ machine-token
//     path, which reuses the same SHA-256 lookup as the other Go domains;
//   - the five write routes additionally require a real platform admin
//     (GlobalRoleAssignment.userId, role = platform_admin). This gate is the
//     DS1 fix: the three settings domains are global singletons with no orgId
//     dimension, so an organisation administrator holding settings.manage must
//     not be able to change them. A machine token can never satisfy the gate
//     because its actor id is not a User row;
//   - the realtime-signals and nominatim writers take the same global MySQL
//     session locks as NestJS (data-runtime-settings:realtime:v1 and
//     data-runtime-settings:nominatim:v1) and merge from the raw MySQL row.
//     This is the DS2 fix: without it, two concurrent partial updates of
//     different fields overwrite each other;
//   - the archive status reader derives its counters and its recent list from a
//     single org-scoped snapshot (the DS4 fix) and redacts credential patterns
//     out of the public failure text through the shared
//     adminlogs.RedactSensitiveFields implementation (the DS3 fix);
//   - stored secrets keep the exact system-settings v1 envelope, so ciphertext
//     written by NestJS decrypts here and vice versa.
//
// Every request and response model is a named struct with explicit json tags.
// JSON values that are inherently schema-less (a stored SystemSetting.value, a
// Redis cache entry, the archive status record) are handled as json.RawMessage
// bytes and decoded into named structs immediately; the package never uses
// any / interface{} / map[string]any.
//
// What deliberately stays on NestJS: the realtime signal collectors, the ACLED
// OAuth refresh, the Nominatim geocoding calls, the archive classification /
// embedding / rerank work, the BullMQ producers and workers, the
// archiveDigest / archiveCalendar / archiveDetail routes, and every GraphQL
// operation. ACLED_API_ENABLED is false in the NestJS source and stays false
// here: no access token is ever reported as usable and no OAuth request is
// made, even when the database still holds a historical token.
package dataruntimesettings
