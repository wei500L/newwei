// Package platformgovernance implements the Go takeover of sixteen platform
// governance settings HTTP routes under /api/system-settings. It is wired only
// when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go; the default (legacy) keeps
// every request on the NestJS proxy, so rollback is a single variable change.
//
// The sixteen exact paths are:
//
//	GET    /api/system-settings/security
//	PUT    /api/system-settings/security
//	GET    /api/system-settings/assistant-quota
//	PUT    /api/system-settings/assistant-quota
//	DELETE /api/system-settings/assistant-quota
//	GET    /api/system-settings/assistant-safety
//	PUT    /api/system-settings/assistant-safety
//	DELETE /api/system-settings/assistant-safety
//	GET    /api/system-settings/assistant-safety/metrics
//	GET    /api/system-settings/task-logs
//	PUT    /api/system-settings/task-logs
//	DELETE /api/system-settings/task-logs
//	GET    /api/system-settings/llm-request-logs
//	PUT    /api/system-settings/llm-request-logs
//	DELETE /api/system-settings/llm-request-logs
//	POST   /api/system-settings/llm-request-logs/metadata-policy/reset
//
// Every route requires the settings.manage permission. Authentication and
// permission derivation reuse the shared authhttp chain (HS256 verification,
// Redis revocation blacklist, MySQL membership re-derivation); permissions are
// never read from JWT claims. The mtk_ machine-token path resolves the token
// row and takes the permission list and orgId from that row.
//
// Nine of the writes target a GLOBAL SystemSetting row (single key, no org
// dimension) and therefore additionally require a platform admin: PUT
// /security, PUT/DELETE /assistant-quota, PUT/DELETE /assistant-safety,
// PUT/DELETE /task-logs and PUT/DELETE/POST /llm-request-logs…/metadata-policy.
// A machine identity can never satisfy that check, mirroring NestJS
// assertPlatformAdmin("machine:<id>"), which finds no GlobalRoleAssignment row.
//
// Failure order matches NestJS exactly: 401 authentication, 403 permission,
// 400 DTO validation (bodies only), 403 platform-admin gate, then the service
// 400/409/500.
//
// The package never carries data in untyped Go containers (the empty
// interface, untyped maps or untyped slices): request DTOs, responses,
// SystemSetting.value shapes, Redis cache envelopes, audit metadata, Mongo
// aggregation results and listIndexes results are all named structs with
// explicit json / bson tags. Schema-less JSON (a stored value, a Mongoose Mixed
// field) is carried as json.RawMessage and decoded into a named struct
// immediately.
package platformgovernance
