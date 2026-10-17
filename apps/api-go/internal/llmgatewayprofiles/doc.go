// Package llmgatewayprofiles implements the Go takeover of the seven
// /api/system-settings/llm-gateways configuration-control routes:
//
//	GET    /api/system-settings/llm-gateways
//	POST   /api/system-settings/llm-gateways
//	PUT    /api/system-settings/llm-gateways/active
//	PUT    /api/system-settings/llm-gateways/embedding-active
//	PUT    /api/system-settings/llm-gateways/rerank-active
//	PUT    /api/system-settings/llm-gateways/:id
//	DELETE /api/system-settings/llm-gateways/:id
//
// The package owns authentication (human JWT chain plus mtk_ machine tokens),
// the platform-admin gate, DTO validation, the AES-256-GCM secret protocol,
// governance protection, the global MySQL session lock and the audit trail. It
// never calls a model upstream: it only reads and writes the global
// SystemSetting document that the not-yet-migrated completion/embedding/rerank
// callers consume.
//
// The routing layer deliberately keeps every other path under
// /api/system-settings/llm-gateways (proxy-governance, proxy-load-balancing,
// test-config, models-config, :id/test, :id/models, :id/proxy-health,
// :id/proxy-model-info, :id/proxy-lb-test) on the legacy reverse proxy, so a
// static path can never be mistaken for a profile id.
package llmgatewayprofiles
