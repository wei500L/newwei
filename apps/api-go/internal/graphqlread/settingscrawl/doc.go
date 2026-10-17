// Package settingscrawl serves the settings center, news-event source policy,
// knowledge-graph evidence review queue and crawl task GraphQL read roots.
//
// The twenty registered Query roots are:
//
//	rateLimitSettings, entityImpactGraphSettings, knowledgeGraphSettings,
//	newsEventSettings, newsEventSourcePolicy, newsEventSourcePolicyPresets,
//	newsEventSourcePolicyRevisionDiff, newsClassificationSettings,
//	classificationQualitySettings, newsDedupeSettings, newsIndicatorSettings,
//	authCacheSettings, crawlClientSettings, auditLogRetention,
//	newsExtractionSettings, newsPromptConfig, newsEventSourcePolicySyncStatus,
//	knowledgeGraphEvidenceReviewQueue, crawlTasks, crawlTask
//
// They are registered only when API_GO_GRAPHQL_READ_MODE=go and
// API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE=go. While the switch is legacy every
// document that selects one of these roots falls back to NestJS as a whole, so
// the production web entry keeps serving through NestJS.
//
// Any document that also selects crawlMetadata, alertRules or a mutation stays
// on NestJS: the first fetches the public internet, the second can enqueue a
// BullMQ job, and every mutation is outside this read-only unit.
//
// orgId and permissions always come from the server-derived membership; the
// executor rejects mtk_ machine tokens for GraphQL reads. Every returned type
// is a named struct with exact graphql tags, every persisted JSON document is
// decoded into a named struct with exact json tags, and the package never uses
// any, interface{}, map[string]any or []any to carry a GraphQL model, a
// SystemSetting value, a source policy revision or delta, a review item or a
// crawl task result.
package settingscrawl
