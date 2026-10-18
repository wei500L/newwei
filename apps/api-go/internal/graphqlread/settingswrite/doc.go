// Package settingswrite serves the thirteen settings center GraphQL mutations:
//
//	updateRateLimitSettings, updateAuthCacheSettings, updateCrawlClientSettings,
//	updateAuditLogRetention, updateEntityImpactGraphSettings,
//	updateKnowledgeGraphSettings, updateNewsEventSettings,
//	updateNewsIndicatorSettings, updateNewsClassificationSettings,
//	updateClassificationQualitySettings, updateNewsDedupeSettings,
//	updateNewsExtractionSettings, updateNewsPromptConfig
//
// They are registered only when API_GO_GRAPHQL_SETTINGS_WRITE_MODE=go. The
// switch is independent of every read switch: with the settings/crawl read
// switch legacy only these mutations are taken over and the twenty settings
// read roots keep serving through NestJS. While the switch is legacy every
// document that selects one of these mutations falls back to NestJS as a whole,
// so the production web entry keeps serving through NestJS.
//
// Every root requires the settings.manage permission and re-derives the fixed
// SettingsResolver.assertAdmin gate from MySQL (a system role of the caller's
// own organization, named "admin" case-insensitively). The input handling ports
// the reachable class-validator constraints, the write path keeps the resolver's
// field-merge semantics, and the stored documents are normalized by the same
// functions the read roots use, so a write and the following read agree. Writes
// refresh the existing Redis settings keys; auditing is best effort through the
// existing AuditLogOutbox fallback. No worker is started, no BullMQ job is
// enqueued and no model, crawl4ai or other upstream service is called.
//
// Every input, persisted document, cache payload and audit metadata value is a
// named struct with exact json tags. The package never uses any, interface{},
// map[string]any or []any to carry business data; json.RawMessage is used only
// where an omitted property must be distinguished from an explicit null.
package settingswrite
